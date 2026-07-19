#!/usr/bin/env python3
import json
path = '/opt/character-arc/data/users/8227fcf2-5d5e-468f-8870-31d8ca52814c/workspace.json'
pid = 'project-1783149829898'
with open(path) as f:
    d = json.load(f)
chapters = {c['id']: c.get('title','') for c in d['workspaces'][pid]['chapters']}
print('=== Journals with autoAcceptancePassed ===')
for doc in d.get('knowledgeDocuments', []):
    if doc.get('sourceLabel') != 'writing-journal':
        continue
    meta = doc.get('metadata') or {}
    if not meta.get('autoAcceptancePassed'):
        continue
    cid = str(meta.get('chapterId', ''))
    print(f"  journal: {doc.get('title','')[:45]}")
    print(f"    chapterId: {cid}")
    print(f"    chapter exists: {cid in chapters} -> {chapters.get(cid, 'MISSING')[:40]}")
