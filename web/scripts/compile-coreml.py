#!/usr/bin/env python3
"""Convert assembled native Maia ONNX models to cached, quantized CoreML bundles.

This runs on the macOS CI runner after prepare-native.mjs. The source ONNX files are
only build intermediates: the script copies a content-addressed .mlmodelc from the
cache when possible, otherwise converts, quantizes, parity-checks, and compiles it.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
from pathlib import Path

# PyTorch/ONNX Runtime can initialize competing OpenMP/Accelerate pools on macOS arm64.
# Keep the conversion process deterministic and avoid native thread-pool SIGSEGVs.
os.environ.setdefault("OMP_NUM_THREADS", "1")
os.environ.setdefault("MKL_NUM_THREADS", "1")
os.environ.setdefault("VECLIB_MAXIMUM_THREADS", "1")
os.environ.setdefault("NUMEXPR_NUM_THREADS", "1")


def _load_conversion_modules():
    print("coreml: importing numpy", flush=True)
    import numpy as np
    print("coreml: importing onnx", flush=True)
    import onnx
    print("coreml: importing onnxruntime", flush=True)
    import onnxruntime as ort
    print("coreml: importing torch", flush=True)
    import torch
    print("coreml: importing onnx2torch", flush=True)
    from onnx2torch import convert as onnx_to_torch
    print("coreml: importing coremltools", flush=True)
    import coremltools as ct
    import coremltools.optimize.coreml as cto
    print("coreml: imports complete", flush=True)
    return np, onnx, ort, torch, onnx_to_torch, ct, cto

MODELS = ("5m", "23m", "79m")
TOKEN_SHAPE = (1, 64, 96)
MOVE_COUNT = 4352
VALUE_COUNT = 3


def compile_model(onnx_path: Path, compiled_path: Path, work_dir: Path) -> None:
    np, onnx, ort, torch, onnx_to_torch, ct, cto = _load_conversion_modules()
    torch.set_num_threads(1)
    torch.set_num_interop_threads(1)

    class Float32Wrapper(torch.nn.Module):
        def __init__(self, base_model: torch.nn.Module) -> None:
            super().__init__()
            self.base = base_model.float()

        def forward(self, tokens, self_elo, oppo_elo):
            move, value = self.base(tokens, self_elo, oppo_elo)
            return move.float(), value.float()

    print(f"=== Processing {onnx_path.name} ===", flush=True)
    onnx_model = onnx.load(str(onnx_path))
    print(f"{onnx_path.stem}: ONNX loaded", flush=True)
    expected_inputs = {"tokens": [1, 64, 96], "self_elo": [1], "oppo_elo": [1]}
    actual_inputs = {
        value.name: [dimension.dim_value for dimension in value.type.tensor_type.shape.dim]
        for value in onnx_model.graph.input
    }
    if actual_inputs != expected_inputs:
        raise RuntimeError(f"{onnx_path.name}: unexpected inputs {actual_inputs}")
    actual_outputs = [value.name for value in onnx_model.graph.output]
    if actual_outputs != ["logits_move", "logits_value"]:
        raise RuntimeError(f"{onnx_path.name}: unexpected outputs {actual_outputs}")
    print(f"{onnx_path.stem}: converting ONNX to Torch", flush=True)
    wrapped = Float32Wrapper(onnx_to_torch(onnx_model)).eval()
    print(f"{onnx_path.stem}: ONNX to Torch complete", flush=True)
    dummy_tokens = torch.randn(*TOKEN_SHAPE, dtype=torch.float32)
    dummy_self_elo = torch.tensor([1500.0], dtype=torch.float32)
    dummy_oppo_elo = torch.tensor([1500.0], dtype=torch.float32)
    with torch.no_grad():
        traced = torch.jit.trace(wrapped, (dummy_tokens, dummy_self_elo, dummy_oppo_elo))
    print(f"{onnx_path.stem}: torch trace complete", flush=True)
    ort_session = ort.InferenceSession(str(onnx_path), providers=["CPUExecutionProvider"])
    ort_move, ort_value = ort_session.run(
        ["logits_move", "logits_value"],
        {"tokens": dummy_tokens.numpy(), "self_elo": dummy_self_elo.numpy(), "oppo_elo": dummy_oppo_elo.numpy()},
    )
    with torch.no_grad():
        torch_move, torch_value = wrapped(dummy_tokens, dummy_self_elo, dummy_oppo_elo)
    torch_move = torch_move.numpy()
    torch_value = torch_value.numpy()
    move_diff = float(np.max(np.abs(ort_move - torch_move)))
    value_diff = float(np.max(np.abs(ort_value - torch_value)))
    same_top = int(np.argmax(ort_move)) == int(np.argmax(torch_move))
    print(f"{onnx_path.stem}: ONNX/Torch parity — move {move_diff:.4f}, value {value_diff:.4f}, top1={same_top}", flush=True)
    assert ort_move.shape[-1] == MOVE_COUNT and torch_move.shape[-1] == MOVE_COUNT
    assert ort_value.shape[-1] == VALUE_COUNT and torch_value.shape[-1] == VALUE_COUNT
    assert same_top or move_diff < 0.25, f"{onnx_path.stem}: ONNX/Torch parity check failed"
    print(f"{onnx_path.stem}: converting to CoreML MLProgram", flush=True)
    mlmodel = ct.convert(
        traced,
        inputs=[
            ct.TensorType(name="tokens", shape=TOKEN_SHAPE, dtype=np.float32),
            ct.TensorType(name="self_elo", shape=(1,), dtype=np.float32),
            ct.TensorType(name="oppo_elo", shape=(1,), dtype=np.float32),
        ],
        outputs=[
            ct.TensorType(name="logits_move", dtype=np.float32),
            ct.TensorType(name="logits_value", dtype=np.float32),
        ],
        minimum_deployment_target=ct.target.iOS17,
        compute_units=ct.ComputeUnit.ALL,
        convert_to="mlprogram",
    )
    spec_outputs = [item.name for item in mlmodel.get_spec().description.output]
    if spec_outputs != ["logits_move", "logits_value"]:
        raise RuntimeError(f"{onnx_path.name}: unexpected CoreML outputs {spec_outputs}")
    print(f"{onnx_path.stem}: CoreML conversion complete", flush=True)
    quantizer = cto.OpLinearQuantizerConfig(mode="linear_symmetric", weight_threshold=512)
    quantized = cto.linear_quantize_weights(
        mlmodel, config=cto.OptimizationConfig(global_config=quantizer)
    )
    print(f"{onnx_path.stem}: INT8 quantization complete", flush=True)
    package_path = work_dir / f"{onnx_path.stem}.mlpackage"
    compile_dir = work_dir / f"compiled-{onnx_path.stem}"
    shutil.rmtree(package_path, ignore_errors=True)
    shutil.rmtree(compile_dir, ignore_errors=True)
    quantized.save(str(package_path))
    compile_dir.mkdir(parents=True, exist_ok=True)
    subprocess.run(["xcrun", "coremlcompiler", "compile", str(package_path), str(compile_dir)], check=True)
    generated = compile_dir / f"{onnx_path.stem}.mlmodelc"
    if not generated.is_dir():
        raise RuntimeError(f"coremlcompiler did not produce {generated}")
    shutil.rmtree(compiled_path, ignore_errors=True)
    shutil.copytree(generated, compiled_path)

def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--native-public-dir", type=Path, default=Path("ios/App/App/public/native"))
    parser.add_argument("--dist-native-dir", type=Path, default=Path("dist-native/native"))
    parser.add_argument("--cache-dir", type=Path, default=Path(".cache/coreml-build"))
    return parser.parse_args()


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def remove_onnx(native_public_dir: Path, dist_native_dir: Path, name: str) -> None:
    for directory in (native_public_dir, dist_native_dir):
        path = directory / f"{name}.onnx"
        if path.exists():
            path.unlink()




def main() -> None:
    args = parse_args()
    native_public_dir = args.native_public_dir
    dist_native_dir = args.dist_native_dir
    cache_dir = args.cache_dir
    cache_dir.mkdir(parents=True, exist_ok=True)
    work_dir = cache_dir / "work"
    work_dir.mkdir(parents=True, exist_ok=True)

    for size in MODELS:
        name = f"maia3-{size}"
        source = native_public_dir / f"{name}.onnx"
        if not source.is_file():
            raise FileNotFoundError(f"Missing assembled ONNX file: {source}")
        digest = sha256(source)
        cached = cache_dir / f"{name}-{digest}.mlmodelc"
        destination = native_public_dir / f"{name}.mlmodelc"
        if cached.is_dir():
            print(f"{name}: using cached {cached.name}")
            shutil.rmtree(destination, ignore_errors=True)
            shutil.copytree(cached, destination)
        else:
            compile_model(source, cached, work_dir)
            shutil.rmtree(destination, ignore_errors=True)
            shutil.copytree(cached, destination)
        remove_onnx(native_public_dir, dist_native_dir, name)

    metadata = {"models": list(MODELS), "format": "mlmodelc", "quantization": "linear_symmetric_int8"}
    (native_public_dir / "maia-models.json").write_text(json.dumps(metadata, indent=2) + "\n")
    print("CoreML compilation complete; raw native ONNX files removed")


if __name__ == "__main__":
    main()
