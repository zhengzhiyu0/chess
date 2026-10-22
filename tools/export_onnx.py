"""Export Maia-3 checkpoints to ONNX and verify parity with PyTorch.

Two targets:
  web     fp32, dynamic batch -> _onnx/maia3-*.onnx and web/public/models/ (browser, onnxruntime-web)
  native  batch fixed to 1, fp16 weights and compute (fp32 inputs/outputs) -> _onnx/native/ and
          web/native-models/ (iOS app, ONNX Runtime + CoreML: static shapes and fp16 ops let CoreML
          run the graph on the Neural Engine, and fp16 halves the bundle)

Usage:
    .venv\Scripts\python.exe tools\export_onnx.py --models 5m 23m 79m --targets web native
"""

import argparse
import math
import sys
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import torch

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "_maia3"))

from maia3.model_registry import resolve_model_spec  # noqa: E402
from maia3.models import MAIA3Model  # noqa: E402


class ExportWrapper(torch.nn.Module):
    """Elo is passed as float so the web side doesn't need int64 tensors.

    Re-implements MAIA3Model.forward with the promotion head vectorized: the original builds
    256 slices and concatenates them, which exports as a 257-input Concat whose WGSL shader
    exceeds WebGPU's nesting limit (ORT's WebGPU EP then returns all-zero move logits)."""

    def __init__(self, model):
        super().__init__()
        self.model = model

    def forward(self, tokens, self_elo, oppo_elo):
        m = self.model
        cfg = m.cfg
        keep = 12 * cfg.history + (3 if cfg.include_time_info else 0)
        tokens = tokens[:, :, :keep]
        s = m.interpolate_elo(self_elo).unsqueeze(1).expand(-1, 64, -1)
        o = m.interpolate_elo(oppo_elo).unsqueeze(1).expand(-1, 64, -1)
        x = m.token_projection(torch.cat([tokens, s, o], dim=-1))
        if hasattr(m, "abs_pe"):
            x = m.abs_pe(x)
        x = m.transformer(x)

        sq_from = m.proj_sq_from(x)
        sq_to = m.proj_sq_to(x)
        scores = torch.matmul(sq_from, sq_to.transpose(1, 2)) / math.sqrt(cfg.head_hid_dim)  # (B, 64, 64)
        # promotions: from rank 7 (squares 48-55) to rank 8 (56-63), order [from_file][to_file][q,r,b,n]
        promo_bias = m.promo_bias_proj(sq_to[:, 56:64, :]) * math.sqrt(cfg.head_hid_dim)  # (B, 8, 4)
        promo = scores[:, 48:56, 56:64].unsqueeze(-1) + promo_bias.unsqueeze(1)  # (B, 8, 8, 4)
        move = torch.cat([scores.flatten(1), promo.flatten(1)], dim=1)  # (B, 4352)

        v = m.last_ln(x.mean(dim=1))
        value = m.fc_value(torch.relu(m.fc_value_hid(v)))
        return move, value


class ManualRMSNorm(torch.nn.Module):
    """ONNX opset 17 has no RMSNorm op; same math as torch.nn.RMSNorm."""

    def __init__(self, src: torch.nn.RMSNorm):
        super().__init__()
        self.weight = src.weight
        self.eps = src.eps if src.eps is not None else torch.finfo(torch.float32).eps

    def forward(self, x):
        return x * torch.rsqrt(x.pow(2).mean(-1, keepdim=True) + self.eps) * self.weight


def replace_rmsnorm(module):
    for name, child in module.named_children():
        if isinstance(child, torch.nn.RMSNorm):
            setattr(module, name, ManualRMSNorm(child))
        else:
            replace_rmsnorm(child)


def build_model(alias, ckpt_path):
    spec = resolve_model_spec(alias)
    cfg = SimpleNamespace(**spec.config)
    model = MAIA3Model(cfg)
    sd = torch.load(ckpt_path, map_location="cpu", weights_only=True)
    if isinstance(sd, dict) and "model_state_dict" in sd:
        sd = sd["model_state_dict"]
    sd = {k.replace("smolgen", "gab"): v for k, v in sd.items()}
    missing, _ = model.load_state_dict(sd, strict=False)
    assert not missing, missing
    model.eval()
    return model, cfg


def split_for_web(onnx_path: Path, dest_dir: Path, chunk_mb: int = 32, extra=None):
    """Split into <=32MB parts: static hosts like GitHub Pages reject files >100MB,
    and chunked fetch gives download progress in the browser."""
    import hashlib
    import json

    if dest_dir.exists():
        for f in dest_dir.iterdir():
            f.unlink()
    dest_dir.mkdir(parents=True, exist_ok=True)
    data = onnx_path.read_bytes()
    digest = hashlib.sha256(data).hexdigest()
    step = chunk_mb * 1024 * 1024
    parts = []
    for i in range(0, len(data), step):
        # content hash in the name: the service worker caches parts cache-first by URL
        name = f"part{len(parts):02d}-{digest[:8]}.bin"
        (dest_dir / name).write_bytes(data[i:i + step])
        parts.append(name)
    manifest = {"size": len(data), "sha256": digest, "parts": parts, **(extra or {})}
    (dest_dir / "manifest.json").write_text(json.dumps(manifest, indent=1))


class HalfWrapper(torch.nn.Module):
    """fp16 weights and compute behind fp32 inputs/outputs (the app's tensors stay fp32).

    CoreML only schedules fp16-typed ML Program ops on the Neural Engine; an fp32 graph runs on
    GPU/CPU. ORT's CPU fallback inserts Casts around any fp16 op it lacks a kernel for."""

    def __init__(self, wrapper):
        super().__init__()
        self.inner = wrapper.half()

    def forward(self, tokens, self_elo, oppo_elo):
        move, value = self.inner(tokens.half(), self_elo.half(), oppo_elo.half())
        return move.float(), value.float()


def export_native(wrapper, cfg, size, out_dir: Path, ort):
    """Batch fixed to 1 (CoreML compiles static shapes fully for the Neural Engine) + fp16.
    COREML_CACHE_KEY makes ORT's compiled-model cache key stable across app updates (otherwise it
    hashes the model path, which changes with every reinstall's bundle location)."""
    import copy
    import hashlib

    import onnx

    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / f"maia3-{size}.onnx"
    half = HalfWrapper(copy.deepcopy(wrapper)).eval()
    tokens = (torch.rand(1, 64, 12 * cfg.history) > 0.9).float()
    elo_s = torch.tensor([1500.0])
    torch.onnx.export(
        half,
        (tokens, elo_s, elo_s),
        str(out_path),
        input_names=["tokens", "self_elo", "oppo_elo"],
        output_names=["logits_move", "logits_value"],
        opset_version=17,
        dynamo=False,
        do_constant_folding=True,
    )
    m = onnx.load(str(out_path))
    digest = hashlib.sha256(m.SerializeToString(deterministic=True)).hexdigest()
    key = f"maia3{size}{digest[:16]}"
    onnx.helper.set_model_props(m, {"COREML_CACHE_KEY": key})
    onnx.save(m, str(out_path))
    onnx.checker.check_model(str(out_path))

    # parity on positions with real move structure: random token planes at several Elo pairs
    worst_m = worst_p = 0.0
    so = ort.SessionOptions()
    so.log_severity_level = 3  # CPU lacks some fp16 kernels; the inserted Casts are expected
    sess = ort.InferenceSession(str(out_path), so, providers=["CPUExecutionProvider"])
    gen = torch.Generator().manual_seed(0)
    for i in range(16):
        t = (torch.rand(1, 64, 12 * cfg.history, generator=gen) > 0.9).float()
        s = torch.tensor([600.0 + 100 * i])
        o = torch.tensor([2100.0 - 90 * i])
        with torch.no_grad():
            ref_m, ref_v = wrapper(t, s, o)
        got_m, got_v = sess.run(None, {"tokens": t.numpy(), "self_elo": s.numpy(), "oppo_elo": o.numpy()})
        ref_p = torch.softmax(ref_m, 1).numpy()
        got_p = torch.softmax(torch.from_numpy(got_m), 1).numpy()
        worst_m = max(worst_m, float(np.abs(got_m - ref_m.numpy()).max()), float(np.abs(got_v - ref_v.numpy()).max()))
        worst_p = max(worst_p, float(np.abs(got_p - ref_p).max()))
        top2 = np.sort(ref_p[0])[-2:]
        if top2[1] - top2[0] > 0.02:
            assert got_m.argmax() == ref_m.numpy().argmax(), f"native {size}: top-1 changed on sample {i}"
    print(f"{size} native: {out_path.stat().st_size / 1e6:.1f}MB  max|dlogit|={worst_m:.2e}  max|dp|={worst_p:.2e}  key={key}")
    assert worst_p < 5e-3, worst_p
    return out_path, key


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--models", nargs="+", default=["5m", "23m", "79m"])
    ap.add_argument("--targets", nargs="+", default=["web", "native"], choices=["web", "native"])
    ap.add_argument("--ckpt-dir", default=str(ROOT / "_ckpt"))
    ap.add_argument("--onnx-dir", default=str(ROOT / "_onnx"))
    ap.add_argument("--web-dir", default=str(ROOT / "web" / "public" / "models"))
    ap.add_argument("--native-dir", default=str(ROOT / "web" / "native-models"))
    args = ap.parse_args()

    import onnxruntime as ort

    out_dir = Path(args.onnx_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    for size in args.models:
        model, cfg = build_model(f"maia3-{size}", Path(args.ckpt_dir) / f"maia3-{size}.pt")
        tokens = (torch.rand(2, 64, 12 * cfg.history) > 0.9).float()
        elo_s = torch.tensor([600.0, 2200.0])
        elo_o = torch.tensor([1500.0, 1100.0])
        with torch.no_grad():
            ref_orig, _, _ = model(tokens, elo_s.long(), elo_o.long())
        replace_rmsnorm(model)
        wrapper = ExportWrapper(model).eval()

        if "native" in args.targets:
            path, key = export_native(wrapper, cfg, size, out_dir / "native", ort)
            # git-tracked like the web parts: the iOS CI build has no checkpoints or torch
            split_for_web(path, Path(args.native_dir) / f"maia3-{size}", extra={"cacheKey": key})
        if "web" not in args.targets:
            continue

        out_path = out_dir / f"maia3-{size}.onnx"
        torch.onnx.export(
            wrapper,
            (tokens, elo_s, elo_o),
            str(out_path),
            input_names=["tokens", "self_elo", "oppo_elo"],
            output_names=["logits_move", "logits_value"],
            dynamic_axes={"tokens": {0: "B"}, "self_elo": {0: "B"}, "oppo_elo": {0: "B"},
                          "logits_move": {0: "B"}, "logits_value": {0: "B"}},
            opset_version=17,
            dynamo=False,
            do_constant_folding=True,
        )

        with torch.no_grad():
            ref_m, ref_v = wrapper(tokens, elo_s, elo_o)
        assert torch.allclose(ref_m, ref_orig, atol=1e-4), (ref_m - ref_orig).abs().max()

        sess = ort.InferenceSession(str(out_path), providers=["CPUExecutionProvider"])
        got_m, got_v = sess.run(None, {"tokens": tokens.numpy(), "self_elo": elo_s.numpy(),
                                       "oppo_elo": elo_o.numpy()})
        dm = np.abs(got_m - ref_m.numpy()).max()
        dv = np.abs(got_v - ref_v.numpy()).max()
        same_top = bool((got_m.argmax(1) == ref_m.numpy().argmax(1)).all())
        size_mb = out_path.stat().st_size / 1e6
        print(f"{size}: {size_mb:.1f}MB  max|dmove|={dm:.2e}  max|dvalue|={dv:.2e}  top1_same={same_top}")
        assert dm < 1e-3 and dv < 1e-3 and same_top
        split_for_web(out_path, Path(args.web_dir) / f"maia3-{size}")


if __name__ == "__main__":
    main()
