import gzip,json,sys,collections
data,pred=sys.argv[1:3]
P={json.loads(l)["id"]:json.loads(l) for l in open(pred)}
c=collections.Counter();h=collections.Counter();K=collections.Counter()
for l in gzip.open(data,"rt"):
    r=json.loads(l);k=r["track"] if r["track"]=="clean" else ("labelled" if r["labelled"] else "unlabelled")
    c[k]+=1;h[k]+=P[r["id"]]["blocked"]
    if k=="clean" and P[r["id"]]["blocked"]:
        for x in P[r["id"]]["kinds"]:K[x]+=1
for k in c: print(f"  {k} {100*h[k]/c[k]:.2f}% ({h[k]}/{c[k]})")
print("  clean kinds",K.most_common(12))
