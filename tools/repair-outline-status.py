#!/usr/bin/env python3
"""Repair outline node statuses and re-link orphaned acceptance journals."""
from __future__ import annotations

import json
import re
import shutil
from datetime import datetime, timezone
from html import unescape
from pathlib import Path

WORKSPACE = Path(
    '/opt/character-arc/data/users/8227fcf2-5d5e-468f-8870-31d8ca52814c/workspace.json'
)
PROJECT_ID = 'project-1783149829898'
VOLUME_ID = 'volume-1783149829899-4edc722e'
MIN_BODY = 50
DRY_RUN = False


def plain_text(content: str) -> str:
    if not content:
        return ''
    text = re.sub(r'<[^>]+>', ' ', content)
    text = unescape(text)
    return re.sub(r'\s+', ' ', text).strip()


def parse_planned_parts(word_target: str) -> int:
    raw = (word_target or '').strip()
    if not raw:
        return 1
    m = re.search(r'(\d+)\s*[–\-~～—]\s*(\d+)\s*章', raw)
    if m:
        lo, hi = int(m.group(1)), int(m.group(2))
        return max(1, round((lo + hi) / 2)) if hi >= lo else max(1, lo)
    m = re.search(r'(\d+)\s*章', raw)
    if m:
        return max(1, int(m.group(1)))
    return 1


def should_skip_node(item: dict) -> bool:
    title = (item.get('title') or '').strip()
    word_target = (item.get('wordTarget') or '').strip()
    if re.search(r'索引条|非单章|写作索引', word_target):
        return True
    if re.search(r'正史总览|写作索引|章级索引', title):
        return True
    return False


def linked_chapters(item: dict, chapters: list) -> list:
    oid = item.get('id', '')
    title = (item.get('title') or '').strip()
    return [
        c for c in chapters
        if c.get('outlineItemId') == oid
        or (
            not c.get('outlineItemId')
            and c.get('volumeId') == VOLUME_ID
            and (c.get('title') or '').strip() == title
        )
    ]


def acceptance_recorded(knowledge_docs: list, chapter_id: str) -> bool:
    for doc in knowledge_docs:
        if doc.get('sourceLabel') != 'writing-journal':
            continue
        meta = doc.get('metadata') or {}
        if str(meta.get('chapterId', '')) == chapter_id and meta.get('autoAcceptancePassed'):
            return True
    return False


def infer_status(item: dict, chapters: list, knowledge_docs: list) -> str:
    if should_skip_node(item):
        return item.get('status') or 'planned'

    planned = parse_planned_parts(item.get('wordTarget', ''))
    linked = linked_chapters(item, chapters)
    with_body = [c for c in linked if len(plain_text(c.get('content', ''))) >= MIN_BODY]
    accepted = [c for c in with_body if acceptance_recorded(knowledge_docs, c.get('id', ''))]

    if len(with_body) == 0:
        return 'planned'
    if len(accepted) >= planned and len(with_body) >= planned:
        return 'done'
    return 'drafting'


def normalize_title_key(value: str) -> str:
    return re.sub(r'\s+', '', value)


def find_chapter_for_journal(doc: dict, chapters: list, outline_items: list) -> str | None:
    title = (doc.get('title') or '').replace('写作日志｜', '').strip()
    key = normalize_title_key(title)

    for chapter in chapters:
        chapter_title = (chapter.get('title') or '').strip()
        if key and normalize_title_key(chapter_title) in key:
            return chapter['id']
        if key and key in normalize_title_key(chapter_title):
            return chapter['id']

    for item in outline_items:
        item_title = (item.get('title') or '').strip()
        if not item_title or item_title not in title:
            continue
        linked = linked_chapters(item, chapters)
        with_body = [c for c in linked if len(plain_text(c.get('content', ''))) >= MIN_BODY]
        if len(with_body) == 1:
            return with_body[0]['id']
        if with_body:
            return with_body[0]['id']
    return None


def main() -> None:
    if not WORKSPACE.exists():
        raise SystemExit(f'missing workspace: {WORKSPACE}')

    backup = WORKSPACE.with_suffix(
        f'.json.bak-{datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")}'
    )
    if not DRY_RUN:
        shutil.copy2(WORKSPACE, backup)
        print(f'backup: {backup}')

    with WORKSPACE.open('r', encoding='utf-8') as f:
        data = json.load(f)

    ws = data['workspaces'][PROJECT_ID]
    outline_items = [i for i in ws.get('outlineItems', []) if i.get('volumeId') == VOLUME_ID]
    chapters = ws.get('chapters', [])
    knowledge = data.get('knowledgeDocuments', [])

    status_changes: list[tuple[str, str, str]] = []
    for item in outline_items:
        old = item.get('status') or 'planned'
        new = infer_status(item, chapters, knowledge)
        if old != new:
            status_changes.append((item.get('title', '')[:40], old, new))
            if not DRY_RUN:
                item['status'] = new

    journal_changes: list[tuple[str, str, str]] = []
    chapter_ids = {c['id'] for c in chapters}
    for doc in knowledge:
        if doc.get('sourceLabel') != 'writing-journal':
            continue
        meta = doc.get('metadata') or {}
        if not meta.get('autoAcceptancePassed'):
            continue
        old_id = str(meta.get('chapterId', ''))
        if old_id in chapter_ids:
            continue
        new_id = find_chapter_for_journal(doc, chapters, outline_items)
        if not new_id:
            journal_changes.append((doc.get('title', '')[:40], old_id, 'UNRESOLVED'))
            continue
        journal_changes.append((doc.get('title', '')[:40], old_id, new_id))
        if not DRY_RUN:
            meta['chapterId'] = new_id
            doc['metadata'] = meta

    if not DRY_RUN:
        with WORKSPACE.open('w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
            f.write('\n')

    print('=== outline status changes ===')
    for title, old, new in status_changes:
        print(f'  {old} -> {new}  |  {title}')
    print(f'total: {len(status_changes)}')

    print('\n=== journal chapterId relinks ===')
    for title, old, new in journal_changes:
        print(f'  {old} -> {new}  |  {title}')
    print(f'total: {len(journal_changes)}')

    unresolved = [x for x in journal_changes if x[2] == 'UNRESOLVED']
    if unresolved:
        print(f'\nWARNING: {len(unresolved)} journal(s) unresolved')


if __name__ == '__main__':
    main()
