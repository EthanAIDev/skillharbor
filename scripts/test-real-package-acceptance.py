"""Read-only acceptance of an existing skill catalog; never calls a model or publishes.

The catalog must be a local copy. Results contain identifiers and counts, not source
text, owner names, credentials, or model context. All generated packages stay in
memory and gateway extraction happens in an isolated temporary directory.
"""
from __future__ import annotations

import argparse
from collections import Counter
import hashlib
import io
import json
import os
from pathlib import Path
import socket
import sys
import tempfile
import zipfile


def digest_files(root: Path) -> tuple[dict[str, str], str]:
    files = {}
    aggregate = hashlib.sha256()
    for path in sorted(root.rglob("*")):
        if path.is_symlink():
            raise RuntimeError("Catalog symlinks are not accepted")
        if path.is_file():
            relative = path.relative_to(root).as_posix()
            value = hashlib.sha256(path.read_bytes()).hexdigest()
            files[relative] = value
            aggregate.update(relative.encode("utf-8") + b"\0" + value.encode("ascii") + b"\n")
    return files, aggregate.hexdigest()


def archive(files: dict[str, bytes]) -> bytes:
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as packed:
        for name, data in sorted(files.items()):
            packed.writestr(name, data)
    return output.getvalue()


def deny_network(*_args, **_kwargs):
    raise RuntimeError("Network access is forbidden during local catalog acceptance")


def preview_text(data: bytes, encoding: str = "utf-8") -> str:
    # Gateway Path.read_text uses universal newlines for UI preview; binary
    # preservation is checked separately against original file SHA-256 values.
    return data.decode(encoding).replace("\r\n", "\n").replace("\r", "\n")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--gateway", type=Path, required=True, help="Gateway source checkout")
    parser.add_argument("--catalog", type=Path, required=True, help="Local read-only skills snapshot")
    parser.add_argument("--report", type=Path, required=True, help="Local JSON result, outside catalog")
    args = parser.parse_args()
    gateway = args.gateway.resolve(strict=True)
    catalog = args.catalog.resolve(strict=True)
    report = args.report.resolve()
    if not (gateway / "skill_gateway" / "store.py").is_file() or not catalog.is_dir():
        parser.error("Expected gateway source and local skills directory")
    if report.is_relative_to(catalog):
        parser.error("Report must be outside the source catalog")

    # Do not load the developer's production configuration or credentials.
    retained = {key: value for key, value in os.environ.items()
                if key.upper() in {"SYSTEMROOT", "WINDIR", "TEMP", "TMP", "PATH"}}
    os.environ.clear()
    os.environ.update(retained)
    sys.dont_write_bytecode = True
    sys.path.insert(0, str(gateway))
    socket.socket.connect = deny_network
    socket.socket.connect_ex = deny_network
    socket.create_connection = deny_network

    before, before_digest = digest_files(catalog)
    analyzer_digest = hashlib.sha256((gateway / "skill_gateway" / "package_analysis.py").read_bytes()).hexdigest()
    checks = Counter()
    failures = []
    rows = []

    def verify(condition: bool, check: str, slug: str = "") -> None:
        checks[check] += 1
        if not condition:
            failures.append({"check": check, **({"slug": slug} if slug else {})})

    with tempfile.TemporaryDirectory(prefix="skillharbor-real-package-acceptance-") as isolated:
        os.environ.update({"GATEWAY_DATA_DIR": str(Path(isolated) / "data"),
                           "GATEWAY_DB": str(Path(isolated) / "gateway.db")})
        for variable in ("GATEWAY_ONEAPI_BASE_URL", "ZEB2_SYNC_URL", "GATEWAY_ZEB2_PORTAL_BASE",
                         "GATEWAY_EMBED_BASE_URL", "GATEWAY_KB_BASE_URL", "ARCHIVE_BASE_URL"):
            os.environ[variable] = "http://127.0.0.1:1"
        from skill_gateway.store import SkillStore

        class ReadOnlyStore(SkillStore):
            def __init__(self, root: Path):
                self.root = root
                self.catalog = super()._list_metadata()

            def _list_metadata(self):
                return [dict(item) for item in self.catalog]

            def _write_meta(self, *_args, **_kwargs):
                raise AssertionError("Catalog write attempted")

        store = ReadOnlyStore(catalog)
        metadata = store._list_metadata()
        for item in metadata:
            slug = item["slug"]
            version = item["current_version"]
            row = {"slug": slug, "version": version}
            try:
                graph = store.structure(slug, version)
                directory = catalog / slug / "versions" / version
                source = {path.relative_to(directory).as_posix(): path.read_bytes()
                          for path in directory.rglob("*") if path.is_file()}
                row.update(kind=graph["kind"], source=graph["source"],
                           components=len(graph["components"]), dependencies=len(graph["dependencies"]),
                           steps=len(graph["steps"]),
                           dependencyStates=dict(Counter(dep["status"] for dep in graph["dependencies"])))
                entry = store.load_skill(slug, version=version)
                verify(entry["kind"] == graph["kind"] and entry["version"] == version,
                       "entry-identity", slug)
                verify(entry["content"] == preview_text(source[graph["entry"]]), "entry-body", slug)

                component_ids = {component["id"] for component in graph["components"]}
                dependency_ids = {dependency["id"] for dependency in graph["dependencies"]}
                for step in graph["steps"]:
                    verify(all(target in {"component:" + value for value in component_ids}
                               | {"dependency:" + value for value in dependency_ids}
                               for target in step["targets"]), "step-target-exists", slug)
                for component in graph["components"]:
                    if component["status"] == "ready":
                        body = store.read_component(slug, component["id"], version)
                        verify(body["version"] == version
                               and body["content"] == preview_text(source[component["path"]], "utf-8-sig"),
                               "component-body", slug)
                for dependency in graph["dependencies"]:
                    if dependency["status"] == "ready":
                        body = store.load_skill(dependency["slug"])
                        verify(body["slug"] == dependency["slug"] and bool(body["content"]),
                               "dependency-detail", slug)

                original = archive(source)
                inspected = store.inspect_zip(original, slug=slug, version=version)
                verify(inspected["structure"] == graph, "original-inspection-consistent", slug)
                analysis = store.analyze_zip(original, slug=slug, version=version)
                row.update(analysisStatus=analysis["status"], analysisKind=analysis["kind"],
                           issueCodes=[issue["code"] for issue in analysis.get("issues", [])],
                           needsAi=bool(analysis.get("needsAi")))
                verify(analysis["status"] in {"ready", "question", "blocked"}, "analysis-contract", slug)
                if analysis["status"] == "ready":
                    assistance = analysis.get("assistance") or {}
                    verify(not assistance.get("errors") and bool(assistance.get("manifestYaml")),
                           "ready-has-verified-manifest", slug)
                    derived = dict(source)
                    manifest_path = assistance["manifestPath"]
                    derived[manifest_path] = assistance["manifestYaml"].encode("utf-8")
                    verify(all(data == derived[name] for name, data in source.items()
                               if name != manifest_path), "derived-original-bytes", slug)
                    final = store.inspect_zip(archive(derived), slug=slug, version=version)
                    verify(not final["errors"] and final["structure"] == analysis["inspection"]["structure"],
                           "ready-strict-inspection", slug)
                    if graph["kind"] == "skill":
                        row["kindChanged"] = analysis["kind"] != graph["kind"]
                else:
                    verify(not analysis.get("assistance"), "nonready-not-applicable", slug)

                # Known existing business acceptance case: all six referenced
                # proposal functions exist. Summary prose must not block it.
                if slug == "zxs-proposal-agent":
                    verify(analysis["status"] == "ready" and analysis["kind"] == "agent",
                           "proposal-business-acceptance", slug)
                if slug == "zxs-fund-apply-agent":
                    # Its existing planned function remains a real unavailable
                    # dependency. It must be surfaced, not silently downgraded.
                    verify(analysis["status"] == "blocked"
                           and "missing_dependency" in row["issueCodes"], "fund-missing-function-visible", slug)
                if slug == "a4-gov-docx":
                    verify(analysis["status"] == "ready" and analysis["kind"] == "skill",
                           "existing-script-business-acceptance", slug)
                if slug == "plan-review-agent":
                    verify(analysis["status"] == "ready" and analysis["kind"] == "agent",
                           "captioned-registry-business-acceptance", slug)
            except Exception as error:
                row["errorType"] = type(error).__name__
                verify(False, "package-exception", slug)
            rows.append(row)

    after, after_digest = digest_files(catalog)
    verify(before == after, "source-files-and-metadata-unchanged")
    verify(any(row["slug"] == "zxs-proposal-agent" for row in rows), "proposal-present")
    verify(any(row["slug"] == "zxs-fund-apply-agent" for row in rows), "fund-present")
    result = {
        "readOnly": True, "networkDisabled": True, "realModelCalled": False,
        "total": len(rows), "kinds": dict(Counter(row.get("kind", "error") for row in rows)),
        "analysisStates": dict(Counter(row.get("analysisStatus", "error") for row in rows)),
        "issueCodes": dict(Counter(code for row in rows for code in row.get("issueCodes", []))),
        "checks": dict(checks), "checkCount": sum(checks.values()), "failures": failures,
        "sourceFileCount": len(before), "sourceDigestBefore": before_digest,
        "sourceDigestAfter": after_digest, "sourceUnchanged": before == after, "items": rows,
        "analyzerSourceSha256": analyzer_digest,
    }
    report.parent.mkdir(parents=True, exist_ok=True)
    report.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({key: result[key] for key in (
        "readOnly", "total", "kinds", "analysisStates", "issueCodes", "checkCount",
        "failures", "sourceFileCount", "sourceUnchanged")}, ensure_ascii=True))
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
