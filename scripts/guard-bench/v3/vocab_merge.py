import json,re,sys
base,syn,amb,out=sys.argv[1:5]
W=json.load(open(base,encoding='utf-8'))
S=json.load(open(syn,encoding='utf-8'))
A={l.strip().lower() for l in open(amb,encoding='utf-8') if l.strip()}
weak=re.compile(r'not-repeats|has-letter|^digits|^id-shape')
n=0
for e in W:
    if e.get('context') is None: continue
    strong=bool(e.get('check')) and not weak.search(e['check'])
    have={w.lower() for w in e['context']}
    for w in S.get(e['id'],[]):
        w=w.strip()
        if not w or w.lower() in have: continue
        if w.lower() in A and not strong: continue
        e['context'].append(w);have.add(w.lower());n+=1
json.dump(W,open(out,'w',encoding='utf-8'),indent=1,ensure_ascii=False)
print('added',n)
