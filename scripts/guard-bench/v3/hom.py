import gzip,json,sys,collections
P={json.loads(l)["id"]:json.loads(l) for l in open(sys.argv[2])}
c=collections.Counter();h=collections.Counter();F=collections.Counter();H=collections.Counter()
for l in gzip.open(sys.argv[1],"rt"):
    r=json.loads(l)
    if r["track"]!="clean":continue
    k="homograph" if "homograph" in r["family"] else "other";c[k]+=1;h[k]+=P[r["id"]]["blocked"]
    if k=="homograph":F[r["family"]]+=1;H[r["family"]]+=P[r["id"]]["blocked"]
for k in c:print(f"  clean/{k} {100*h[k]/c[k]:.2f}% ({h[k]}/{c[k]})")
print("  ",{f:round(100*H[f]/F[f]) for f in F})
