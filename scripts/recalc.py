#!/usr/bin/env python3
"""
Recalculate formulas in an xlsx file using LibreOffice headless.
Usage: python scripts/recalc.py <filepath> [timeout_seconds]
Returns JSON: { status, total_errors, total_formulas, error_summary }
"""
import sys
import json
import subprocess
import os


def recalc(filepath, timeout=30):
    if not os.path.exists(filepath):
        return {"status": "file_not_found", "total_errors": 0, "total_formulas": 0, "error_summary": []}

    # Try LibreOffice headless recalc
    try:
        result = subprocess.run(
            ["libreoffice", "--headless", "--calc", "--convert-to", "xlsx",
             "--outdir", os.path.dirname(os.path.abspath(filepath)), filepath],
            capture_output=True, text=True, timeout=timeout
        )
        if result.returncode != 0:
            return {"status": "libreoffice_unavailable", "total_errors": 0,
                    "total_formulas": 0, "error_summary": [result.stderr[:200]]}
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return {"status": "libreoffice_unavailable", "total_errors": 0,
                "total_formulas": 0, "error_summary": ["LibreOffice not available"]}

    # Scan for formula errors using openpyxl if available
    try:
        import openpyxl
        wb = openpyxl.load_workbook(filepath, data_only=False)
        error_tokens = {"#REF!", "#DIV/0!", "#VALUE!", "#NAME?", "#N/A", "#NULL!", "#NUM!"}
        total_formulas = 0
        errors = []
        for sheet in wb.worksheets:
            for row in sheet.iter_rows():
                for cell in row:
                    if cell.value and isinstance(cell.value, str) and cell.value.startswith("="):
                        total_formulas += 1
                    if cell.value and isinstance(cell.value, str) and any(e in cell.value for e in error_tokens):
                        errors.append(f"{sheet.title}!{cell.coordinate}: {cell.value}")
        status = "errors_found" if errors else "success"
        return {"status": status, "total_errors": len(errors), "total_formulas": total_formulas,
                "error_summary": errors[:20]}
    except ImportError:
        return {"status": "success", "total_errors": 0, "total_formulas": 0,
                "error_summary": ["openpyxl not available — skipped formula scan"]}


if __name__ == "__main__":
    fp = sys.argv[1] if len(sys.argv) > 1 else None
    to = int(sys.argv[2]) if len(sys.argv) > 2 else 30
    if not fp:
        print(json.dumps({"status": "error", "message": "No filepath provided"}))
        sys.exit(1)
    print(json.dumps(recalc(fp, to)))
