#!/usr/bin/env python3
"""Audit outline node status vs chapters + acceptance journals."""
import json
import re
import sys
from html import unescape

WORKSPACE = sys.argv[1] if len(sys.argv) > 1 else (
    '/opt/character-arc/data/users/8227fcf2-5d5e-468f-8870-31d8ca52814c/workspace.json'
)
PROJECT_ID = sys.argv[2] if len(sys.argv) > 2 else 'project-1783149829898'
VOLUME_ID = sys.argv[3] if len(sys.argv) > 3 else 'volume-1783149829899-4edc722e'
MIN_BODY = 50


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


def acceptance_recorded(knowledge_docs: list, chapter_id: str) -> bool:
    for doc in knowledge_docs:
        if not isinstance(doc, dict):
            continue
        if doc.get('sourceLabel') != 'writing-journal':
            continue
        meta = doc.get('metadata') or {}
        if str(meta.get('chapterId', '')) == chapter_id and meta.get('autoAcceptancePassed'):
            return True
    return False


def infer_expected_status(item: dict, linked: list, knowledge_docs: list) -> str:
    if should_skip_node(item):
        return 'skip'

    planned = parse_planned_parts(item.get('wordTarget', ''))
    with_body = [c for c in linked if len(plain_text(c.get('content', ''))) >= MIN_BODY]
    accepted = [c for c in with_body if acceptance_recorded(knowledge_docs, c.get('id', ''))]

    if len(with_body) == 0:
        return 'planned'  # or idea if never touched; keep planned as default expectation

    if len(accepted) >= planned and len(with_body) >= planned:
        return 'done'

    if len(with_body) > 0:
        return 'drafting'

    return 'planned'


def chapter_summary(c: dict, knowledge_docs: list) -> dict:
    body_len = len(plain_text(c.get('content', '')))
    cid = c.get('id', '')
    return {
        'id': cid,
        'title': (c.get('title') or '')[:40],
        'status': c.get('status'),
        'chars': body_len,
        'accepted': acceptance_recorded(knowledge_docs, cid),
    }


with open(WORKSPACE, 'r', encoding='utf-8') as f:
    data = json.load(f)

ws = data.get('workspaces', {}).get(PROJECT_ID, {})
outline_items = [i for i in ws.get('outlineItems', []) if i.get('volumeId') == VOLUME_ID]
chapters = ws.get('chapters', [])
knowledge = data.get('knowledgeDocuments', [])

outline_items.sort(key=lambda x: x.get('sortOrder', 0))

mismatches = []
ok_count = 0
skip_count = 0

print(f'Project: {PROJECT_ID}')
print(f'Volume: {VOLUME_ID}')
print(f'Outline nodes: {len(outline_items)}')
print(f'Chapters in project: {len(chapters)}')
print()
print(f"{'#':>3}  {'status':8}  {'expect':8}  {'parts':5}  {'body':4}  {'acc':3}  title")
print('-' * 90)

for idx, item in enumerate(outline_items, 1):
    oid = item.get('id', '')
    title = (item.get('title') or '').strip()
    actual = item.get('status') or 'planned'

    linked = [
        c for c in chapters
        if c.get('outlineItemId') == oid
        or (
            not c.get('outlineItemId')
            and c.get('volumeId') == VOLUME_ID
            and (c.get('title') or '').strip() == title
        )
    ]
    planned = parse_planned_parts(item.get('wordTarget', ''))
    with_body = [c for c in linked if len(plain_text(c.get('content', ''))) >= MIN_BODY]
    accepted = [c for c in with_body if acceptance_recorded(knowledge, c.get('id', ''))]
    expected = infer_expected_status(item, linked, knowledge)

    if expected == 'skip':
        skip_count += 1
        mark = 'SKIP'
    elif actual == expected:
        ok_count += 1
        mark = 'OK'
    else:
        mismatches.append({
            'index': idx,
            'id': oid,
            'title': title,
            'actual': actual,
            'expected': expected,
            'planned_parts': planned,
            'linked_chapters': len(linked),
            'with_body': len(with_body),
            'accepted': len(accepted),
            'chapters': [chapter_summary(c, knowledge) for c in linked],
        })
        mark = 'MISMATCH'

    if expected != 'skip':
        print(
            f"{idx:3d}  {actual:8}  {expected:8}  {len(with_body)}/{planned:<3}  "
            f"{len(with_body):4}  {len(accepted):3}  {mark}  {title[:36]}"
        )

print()
print(f'OK: {ok_count}  MISMATCH: {len(mismatches)}  SKIP(index): {skip_count}')

if mismatches:
    print('\n=== Mismatch details ===')
    for m in mismatches:
        print()
        print(f"[{m['index']}] {m['title']}")
        print(f"  node id: {m['id']}")
        print(f"  stored status: {m['actual']}  ->  expected: {m['expected']}")
        print(f"  planned parts: {m['planned_parts']}, linked chapters: {m['linked_chapters']}, "
              f"with body: {m['with_body']}, accepted: {m['accepted']}")
        for ch in m['chapters']:
            print(f"    - {ch['title']} | status={ch['status']} | {ch['chars']} chars | accepted={ch['accepted']}")
