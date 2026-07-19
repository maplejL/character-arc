#!/usr/bin/env python3
import json
import sys

path = sys.argv[1] if len(sys.argv) > 1 else '/opt/character-arc/data/users/8227fcf2-5d5e-468f-8870-31d8ca52814c/workspace.json'
with open(path, 'r', encoding='utf-8') as f:
    data = json.load(f)
projects = data.get('projects', [])
ws = data.get('workspaces', {})
pid = data.get('selectedProjectId') or (projects[0]['id'] if projects else '')
chapters = ws.get(pid, {}).get('chapters', []) if pid else []
print('json ok')
print('projects', len(projects))
print('selected', pid)
print('chapters', len(chapters) if isinstance(chapters, list) else 'bad')
if isinstance(chapters, list):
    with_content = sum(1 for c in chapters if isinstance(c, dict) and str(c.get('content', '')).strip())
    print('chapters_with_content', with_content)
