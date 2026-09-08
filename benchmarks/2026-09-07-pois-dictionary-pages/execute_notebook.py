#!/usr/bin/env python3
"""Minimal stdlib notebook executor for this text-output-only benchmark."""

from __future__ import annotations

import contextlib
import io
import json
import sys
import traceback
from pathlib import Path


notebook_path = Path(sys.argv[1])
notebook = json.loads(notebook_path.read_text())
namespace = {"__name__": "__main__"}
execution_count = 0

for cell in notebook["cells"]:
    if cell["cell_type"] != "code":
        continue
    execution_count += 1
    stdout = io.StringIO()
    stderr = io.StringIO()
    cell["execution_count"] = execution_count
    cell["outputs"] = []
    source = "".join(cell["source"])
    try:
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            exec(compile(source, f"{notebook_path.name}:cell-{execution_count}", "exec"), namespace)
    except Exception as error:
        cell["outputs"].append({
            "output_type": "error",
            "ename": type(error).__name__,
            "evalue": str(error),
            "traceback": traceback.format_exc().splitlines(),
        })
        notebook_path.write_text(json.dumps(notebook, indent=1) + "\n")
        raise
    if stdout.getvalue():
        cell["outputs"].append({
            "output_type": "stream",
            "name": "stdout",
            "text": stdout.getvalue().splitlines(keepends=True),
        })
    if stderr.getvalue():
        cell["outputs"].append({
            "output_type": "stream",
            "name": "stderr",
            "text": stderr.getvalue().splitlines(keepends=True),
        })

notebook_path.write_text(json.dumps(notebook, indent=1) + "\n")

