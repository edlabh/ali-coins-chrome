#!/usr/bin/env python3
"""
Gera o pacote limpo da extensão para distribuição/release:
  dist/ali-coins-chrome-<version>.zip
  dist/SHA256SUMS.txt
Inclui apenas manifest.json, LICENSE, README.md, icons/ e src/.
"""

import hashlib
import json
import pathlib
import zipfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
DIST = ROOT / "dist"


def main() -> None:
    manifest = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))
    pkg = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
    version = manifest["version"]
    if pkg["version"] != version:
        raise SystemExit(
            f"Erro: manifest.json ({version}) != package.json ({pkg['version']})"
        )

    DIST.mkdir(parents=True, exist_ok=True)
    prefix = f"ali-coins-chrome-{version}"
    zip_name = f"{prefix}.zip"
    zip_path = DIST / zip_name

    files_to_pack: list[tuple[pathlib.Path, str]] = [
        (ROOT / "manifest.json", f"{prefix}/manifest.json"),
        (ROOT / "LICENSE", f"{prefix}/LICENSE"),
        (ROOT / "README.md", f"{prefix}/README.md"),
    ]
    for folder in ("icons", "src"):
        for path in sorted((ROOT / folder).rglob("*")):
            if path.is_file():
                rel = path.relative_to(ROOT).as_posix()
                files_to_pack.append((path, f"{prefix}/{rel}"))

    with zipfile.ZipFile(
        zip_path, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9
    ) as zf:
        for src_path, arcname in files_to_pack:
            info = zipfile.ZipInfo(arcname)
            info.date_time = (2026, 1, 1, 0, 0, 0)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            zf.writestr(info, src_path.read_bytes(), compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)

    sha = hashlib.sha256(zip_path.read_bytes()).hexdigest()
    sums_path = DIST / "SHA256SUMS.txt"
    sums_path.write_text(f"{sha}  {zip_name}\n", encoding="utf-8")

    size_kb = zip_path.stat().st_size / 1024
    print(f"✓ Pacote gerado: {zip_path} ({size_kb:.1f} KB, {len(files_to_pack)} arquivos)")
    print(f"✓ SHA-256: {sha}")


if __name__ == "__main__":
    main()
