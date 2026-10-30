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
MODELS = ("5m", "23m", "79m")
TOKEN_SHAPE = (1, 64, 96)
MOVE_COUNT = 4352
VALUE_COUNT = 3



def _load_conversion_modules():
    print("coreml: importing onnx", flush=True)
    import onnx
    print("coreml: importing onnx2coreml", flush=True)
    import onnx2coreml as o2c
    print("coreml: importing coremltools", flush=True)
    import coremltools.optimize.coreml as cto
    print("coreml: imports complete", flush=True)
    return onnx, o2c, cto


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


def prepare_coreml_graph(model):
    """Normalize the fp16 export to fp32 MIL authoring; the backend restores fp16 compute."""
    import numpy as np
    import onnx

    nodes = []
    for node in model.graph.node:
        if node.op_type == 'Constant':
            value = next(attr.t for attr in node.attribute if attr.name == 'value')
            tensor = onnx.TensorProto()
            tensor.CopyFrom(value)
            tensor.name = node.output[0]
            model.graph.initializer.append(tensor)
        elif node.op_type == 'Einsum':
            equation = next(attr.s for attr in node.attribute if attr.name == 'equation')
            if equation != b'bhi,oi->bho':
                raise ValueError(f'Unsupported Einsum equation: {equation!r}')
            transposed = node.output[0] + '_weight_transposed'
            nodes.append(onnx.helper.make_node(
                'Transpose', [node.input[1]], [transposed], perm=[1, 0], name=node.name + '_transpose',
            ))
            nodes.append(onnx.helper.make_node(
                'MatMul', [node.input[0], transposed], list(node.output), name=node.name,
            ))
        else:
            nodes.append(node)
    for tensor in model.graph.initializer:
        if tensor.data_type == onnx.TensorProto.FLOAT16:
            tensor.CopyFrom(onnx.numpy_helper.from_array(
                onnx.numpy_helper.to_array(tensor).astype(np.float32), name=tensor.name,
            ))
    for value in (*model.graph.input, *model.graph.output, *model.graph.value_info):
        if value.type.tensor_type.elem_type == onnx.TensorProto.FLOAT16:
            value.type.tensor_type.elem_type = onnx.TensorProto.FLOAT
    for node in nodes:
        for attr in node.attribute:
            if node.op_type == 'Cast' and attr.name == 'to' and attr.i == onnx.TensorProto.FLOAT16:
                attr.i = onnx.TensorProto.FLOAT
    del model.graph.node[:]
    model.graph.node.extend(nodes)
    onnx.checker.check_model(model)
    return model


def verify_compiled_model(compiled: Path, source: Path) -> None:
    """Run the shipped INT8 model against ONNX on existing encoded chess fixtures."""
    import numpy as np
    import onnxruntime as ort
    import coremltools as ct

    cases = json.loads((Path(__file__).resolve().parents[1] / 'test/golden.json').read_text())['cases']
    fixtures = [case for case in cases if case['model'] == '5m']
    options = ort.SessionOptions()
    options.intra_op_num_threads = 1
    options.inter_op_num_threads = 1
    options.log_severity_level = 3  # fp16 constant folding uses inserted Casts on CPU.
    reference = ort.InferenceSession(str(source), options, providers=['CPUExecutionProvider'])
    model = ct.models.CompiledMLModel(str(compiled), compute_units=ct.ComputeUnit.ALL)

    def probabilities(logits):
        values = np.exp(logits.astype(np.float64) - np.max(logits))
        return values / values.sum()

    worst_move = worst_value = 0.0
    for case in fixtures:
        tokens = np.zeros(TOKEN_SHAPE, dtype=np.float32)
        for square, feature in case['tokens_nonzero']:
            tokens[0, square, feature] = 1
        inputs = {
            'tokens': tokens,
            'self_elo': np.array([case['self']], dtype=np.float32),
            'oppo_elo': np.array([case['oppo']], dtype=np.float32),
        }
        expected = reference.run(['logits_move', 'logits_value'], inputs)
        result = model.predict(inputs)
        actual = [result['logits_move'], result['logits_value']]
        for index, shape in enumerate(((1, MOVE_COUNT), (1, VALUE_COUNT))):
            if actual[index].shape != shape or not np.isfinite(actual[index]).all():
                raise RuntimeError(f'{source.stem}/{case["name"]}: invalid CoreML output {index}')
            left, right = expected[index][0], actual[index][0]
            if index == 0:
                left, right = left[case['legal_idx']], right[case['legal_idx']]
            delta = float(np.max(np.abs(probabilities(left) - probabilities(right))))
            if not np.isfinite(delta) or delta > 0.02:
                raise RuntimeError(f'{source.stem}/{case["name"]}: probability delta {delta:.6f} exceeds 0.02 (output {index})')
            if index == 0:
                worst_move = max(worst_move, delta)
            else:
                worst_value = max(worst_value, delta)
    print(f'{source.stem}: {len(fixtures)} compiled-model samples passed; max probability delta move={worst_move:.6f}, value={worst_value:.6f}', flush=True)


def compile_model(onnx_path: Path, compiled_path: Path, work_dir: Path) -> None:
    onnx, o2c, cto = _load_conversion_modules()
    print(f"=== Processing {onnx_path.name} ===", flush=True)
    onnx_model = onnx.load(str(onnx_path))
    onnx.checker.check_model(onnx_model)
    _check_onnx(onnx_model, onnx_path.name)
    print(f"{onnx_path.stem}: ONNX loaded and contract checked", flush=True)
    print(f"{onnx_path.stem}: converting ONNX directly to CoreML MLProgram", flush=True)

    mlmodel = o2c.convert(
        prepare_coreml_graph(onnx_model),
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
    # Preserve GAB's attention-bias generator: its error is injected into every
    # attention map. The main transformer matrices still use INT8 weights.
    preserved = {
        name: None
        for name, metadata in cto.get_weights_metadata(mlmodel, weight_threshold=512).items()
        if 'Einsum_output_0_weight_transposed' in name
        or any('self_attn_sm' in child.name for child in metadata.child_ops)
    }
    print(f'{onnx_path.stem}: preserving {len(preserved)} attention-bias tensors in fp16', flush=True)
    quantized = cto.linear_quantize_weights(
        mlmodel, config=cto.OptimizationConfig(global_config=quantizer, op_name_configs=preserved)
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
    verify_compiled_model(generated, onnx_path)
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
