#!/usr/bin/env python3
import json
path = '/opt/character-arc/data/users/8227fcf2-5d5e-468f-8870-31d8ca52814c/workspace.json'
with open(path) as f:
    d = json.load(f)
j = [x for x in d.get('knowledgeDocuments', []) if x.get('sourceLabel') == 'writing-journal']
acc = [x for x in j if (x.get('metadata') or {}).get('autoAcceptancePassed')]
print('writing_journals', len(j))
print('auto_acceptance_passed', len(acc))
for x in acc:
    print(' -', x.get('title', '')[:50])
