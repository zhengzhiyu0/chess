"""Export Maia-3 checkpoints to ONNX and verify parity with PyTorch.

Usage:
    .venv\Scripts\python.exe tools\export_onnx.py --models 5m 23m 79m
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


def split_for_web(onnx_path: Path, dest_dir: Path, chunk_mb: int = 32):
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
    manifest = {"size": len(data), "sha256": digest, "parts": parts}
    (dest_dir / "manifest.json").write_text(json.dumps(manifest, indent=1))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--models", nargs="+", default=["5m", "23m", "79m"])
    ap.add_argument("--ckpt-dir", default=str(ROOT / "_ckpt"))
    ap.add_argument("--onnx-dir", default=str(ROOT / "_onnx"))
    ap.add_argument("--web-dir", default=str(ROOT / "web" / "public" / "models"))
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
