"""Generate reference outputs from the original PyTorch Maia-3 pipeline.

The web encoder (web/src/maia/encode.ts) is tested against these values to make sure
the browser implementation reproduces the official tokenization, history handling,
move indexing and legal-move masking exactly.

Usage:
    .venv\Scripts\python.exe tools\make_golden.py
"""

import json
import sys
from collections import deque
from pathlib import Path
from types import SimpleNamespace

import chess
import torch

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "_maia3"))

from maia3.dataset import get_historical_tokens, get_legal_moves_mask, tokenize_board  # noqa: E402
from maia3.utils import get_all_possible_moves, mirror_move  # noqa: E402

sys.path.insert(0, str(ROOT / "tools"))
from export_onnx import build_model  # noqa: E402

START = chess.STARTING_FEN
CASES = [
    {"name": "startpos", "fen": START, "moves": [], "self": 1500, "oppo": 1500},
    {"name": "after e4 (black)", "fen": START, "moves": ["e2e4"], "self": 1100, "oppo": 1900},
    {"name": "italian castled (history>8)", "fen": START,
     "moves": ["e2e4", "e7e5", "g1f3", "b8c6", "f1c4", "f8c5", "c2c3", "g8f6", "d2d3", "d7d6", "e1g1"],
     "self": 600, "oppo": 600},
    {"name": "black to castle", "fen": START,
     "moves": ["d2d4", "g8f6", "c2c4", "g7g6", "b1c3", "f8g7", "e2e4", "d7d6", "g1f3"],
     "self": 2200, "oppo": 2000},
    {"name": "white promotion fen", "fen": "8/P7/8/8/8/8/k6K/8 w - - 0 1", "moves": [],
     "self": 1500, "oppo": 1500},
    {"name": "black promotion fen", "fen": "K7/8/8/8/8/8/1p5k/8 b - - 0 1", "moves": [],
     "self": 1300, "oppo": 1700},
    {"name": "en passant available", "fen": START,
     "moves": ["e2e4", "a7a6", "e4e5", "d7d5"], "self": 1800, "oppo": 1800},
]


def main():
    all_moves = get_all_possible_moves()
    moves_dict = {m: i for i, m in enumerate(all_moves)}
    out = {"cases": []}

    for size in ["5m", "23m", "79m"]:
        model, cfg = build_model(f"maia3-{size}", ROOT / "_ckpt" / f"maia3-{size}.pt")
        for case in CASES:
            board = chess.Board(case["fen"])
            history = deque(maxlen=cfg.history)
            history.append(tokenize_board(board))
            for mv in case["moves"]:
                board.push(chess.Move.from_uci(mv))
                history.append(tokenize_board(board))

            tokens = get_historical_tokens(history, cfg, 0.0, 0.0, 0.0, 0.0).unsqueeze(0)
            mask = get_legal_moves_mask(board, moves_dict)
            with torch.no_grad():
                logits, value, _ = model(tokens, torch.tensor([case["self"]]), torch.tensor([case["oppo"]]))
            logits = logits[0].masked_fill(~mask, float("-inf"))
            probs = torch.softmax(logits, -1)
            top_p, top_i = torch.topk(probs, k=min(5, int(mask.sum())))
            top = []
            for p, i in zip(top_p.tolist(), top_i.tolist()):
                uci = all_moves[i]
                if board.turn == chess.BLACK:
                    uci = mirror_move(uci)
                top.append({"uci": uci, "p": p})
            loss, draw, win = torch.softmax(value[0], -1).tolist()
            entry = {**case, "model": size, "top": top, "wdl": [win, draw, loss]}
            if size == "5m":
                entry["tokens_sum"] = float(tokens[0, :, :12 * cfg.history].sum())
                entry["tokens_nonzero"] = [
                    [int(s), int(f)] for s, f in torch.nonzero(tokens[0, :, :12 * cfg.history]).tolist()
                ]
                entry["legal_idx"] = torch.nonzero(mask).flatten().tolist()
            out["cases"].append(entry)
        print(f"{size}: done")

    dest = ROOT / "web" / "test" / "golden.json"
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(json.dumps(out, indent=1))
    print("wrote", dest)


if __name__ == "__main__":
    main()
