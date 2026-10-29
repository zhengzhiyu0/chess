#!/usr/bin/env python3
"""Convert assembled native Maia ONNX models to cached CoreML bundles."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
from pathlib import Path

os.environ.setdefault("OMP_NUM_THREADS", "1")
os.environ.setdefault("MKL_NUM_THREADS", "1")
os.environ.setdefault("VECLIB_MAXIMUM_THREADS", "1")
os.environ.setdefault("NUMEXPR_NUM_THREADS", "1")

MODELS = ("5m", "23m", "79m")
TOKEN_SHAPE = (1, 64, 96)
MOVE_COUNT = 4352
VALUE_COUNT = 3


def _load_conversion_modules():
    print("coreml: importing numpy", flush=True)
    import numpy as np
    print("coreml: importing onnx", flush=True)
    import onnx
    print("coreml: importing onnxruntime", flush=True)
    import onnxruntime as ort
    print("coreml: importing onnx2coreml", flush=True)
    import onnx2coreml as o2c
    print("coreml: importing coremltools", flush=True)
    import coremltools.optimize.coreml as cto
    print("coreml: imports complete", flush=True)
    return np, onnx, ort, o2c, cto


def _check_onnx(onnx_model, name: str) -> None:
    expected_inputs = {"tokens": [1, 64, 96], "self_elo": [1], "oppo_elo": [1]}
    actual_inputs = {
        value.name: [dimension.dim_value for dimension in value.type.tensor_type.shape.dim]
        for value in onnx_model.graph.input
    }
    if actual_inputs != expected_inputs:
        raise RuntimeError(f"{name}: unexpected inputs {actual_inputs}")
    actual_outputs = [value.name for value in onnx_model.graph.output]
    if actual_outputs != ["logits_move", "logits_value"]:
        raise RuntimeError(f"{name}: unexpected outputs {actual_outputs}")


def compile_model(onnx_path: Path, compiled_path: Path, work_dir: Path) -> None:
    np, onnx, ort, o2c, cto = _load_conversion_modules()
    print(f"=== Processing {onnx_path.name} ===", flush=True)
    onnx_model = onnx.load(str(onnx_path))
    onnx.checker.check_model(onnx_model)
    _check_onnx(onnx_model, onnx_path.name)
    print(f"{onnx_path.stem}: ONNX loaded and contract checked", flush=True)

    dummy = {
        "tokens": np.random.default_rng(0).standard_normal(TOKEN_SHAPE).astype(np.float32),
        "self_elo": np.array([1500.0], dtype=np.float32),
        "oppo_elo": np.array([1500.0], dtype=np.float32),
    }
    ort_session = ort.InferenceSession(str(onnx_path), providers=["CPUExecutionProvider"])
    ort_move, ort_value = ort_session.run(["logits_move", "logits_value"], dummy)
    if ort_move.shape[-1] != MOVE_COUNT or ort_value.shape[-1] != VALUE_COUNT:
        raise RuntimeError(f"{onnx_path.name}: unexpected ONNX output shapes")
    if not np.isfinite(ort_move).all() or not np.isfinite(ort_value).all():
        raise RuntimeError(f"{onnx_path.name}: ONNX produced non-finite output")
    print(f"{onnx_path.stem}: ONNX CPU smoke passed", flush=True)

    print(f"{onnx_path.stem}: converting ONNX directly to CoreML MLProgram", flush=True)
    mlmodel = o2c.convert(
        str(onnx_path),
        format="mlpackage",
        minimum_deployment_target="iOS17",
        compute_precision="fp16",
        verify=False,
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
    print(f"{onnx_path.stem}: compiling .mlpackage", flush=True)
    subprocess.run(["xcrun", "coremlcompiler", "compile", str(package_path), str(compile_dir)], check=True)
    generated = compile_dir / f"{onnx_path.stem}.mlmodelc"
    if not generated.is_dir():
        raise RuntimeError(f"coremlcompiler did not produce {generated}")
    shutil.rmtree(compiled_path, ignore_errors=True)
    shutil.copytree(generated, compiled_path)
    print(f"{onnx_path.stem}: compiled bundle ready", flush=True)


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
            print(f"{name}: using cached {cached.name}", flush=True)
            shutil.rmtree(destination, ignore_errors=True)
            shutil.copytree(cached, destination)
        else:
            compile_model(source, cached, work_dir)
            shutil.rmtree(destination, ignore_errors=True)
            shutil.copytree(cached, destination)
        remove_onnx(native_public_dir, dist_native_dir, name)
    metadata = {"models": list(MODELS), "format": "mlmodelc", "quantization": "linear_symmetric_int8"}
    (native_public_dir / "maia-models.json").write_text(json.dumps(metadata, indent=2) + "\n")
    print("CoreML compilation complete; raw native ONNX files removed", flush=True)


if __name__ == "__main__":
    main()
