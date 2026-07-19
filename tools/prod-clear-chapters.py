#!/usr/bin/env python3
"""Clear chapter body + acceptance for chapters by index (1-based) before auto-creation rerun."""
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

WORKSPACE = Path(
    sys.argv[1]
    if len(sys.argv) > 1
    else "/opt/character-arc/data/users/8227fcf2-5d5e-468f-8870-31d8ca52814c/workspace.json",
)
PROJECT_ID = sys.argv[2] if len(sys.argv) > 2 else "project-1783149829898"
VOLUME_ID = sys.argv[3] if len(sys.argv) > 3 else "volume-1783149829899-4edc722e"
INDICES_RAW = sys.argv[4] if len(sys.argv) > 4 else "1,2,3"
NOW = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def chapter_index(title: str) -> int | None:
    m = re.search(r"第(\d+)章", title or "")
    return int(m.group(1)) if m else None


def main() -> None:
    data = json.loads(WORKSPACE.read_text(encoding="utf-8"))
    ws = data["workspaces"][PROJECT_ID]
    chapters = [c for c in ws.get("chapters", []) if c.get("volumeId") == VOLUME_ID]
    index_to_chapter = {}
    for ch in chapters:
        idx = chapter_index(ch.get("title", ""))
        if idx is not None:
            index_to_chapter[idx] = ch

    if INDICES_RAW.strip().lower() == "all":
        indices = set(index_to_chapter.keys())
    else:
        indices = {int(x) for x in INDICES_RAW.split(",") if x.strip()}

    missing = sorted(i for i in indices if i not in index_to_chapter)
    if missing:
        print(f"WARN: chapter indices not found: {missing}")

    target_ids = {index_to_chapter[i]["id"] for i in indices if i in index_to_chapter}
    cleared_bodies = 0
    for ch in chapters:
        if ch.get("id") not in target_ids:
            continue
        old_len = len(str(ch.get("content") or ""))
        if old_len > 0:
            ch["content"] = ""
            ch["status"] = "draft"
            ch["clearedForRerunAt"] = NOW
            cleared_bodies += 1
            print(f"  cleared body: idx={chapter_index(ch.get('title', ''))} id={ch['id']} was={old_len} chars")

    cleared_acceptance = 0
    for doc in data.get("knowledgeDocuments", []):
        if doc.get("sourceLabel") != "writing-journal":
            continue
        meta = doc.setdefault("metadata", {})
        cid = str(meta.get("chapterId", ""))
        if cid in target_ids:
            if meta.get("autoAcceptancePassed"):
                meta["autoAcceptancePassed"] = False
                cleared_acceptance += 1
            meta["qualityRerunClearedAt"] = NOW
            print(f"  reset journal: chapterId={cid} title={doc.get('title', '')[:40]}")

    WORKSPACE.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    print(
        f"\nDone: cleared {cleared_bodies} chapter bodies, "
        f"reset {cleared_acceptance} acceptance flags for indices {sorted(indices)}"
    )


if __name__ == "__main__":
    main()
