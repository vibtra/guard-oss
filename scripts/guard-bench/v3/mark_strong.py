import json,sys,re
D,rates=sys.argv[1:3]
thr=float(sys.argv[3]) if len(sys.argv)>3 else 0.015
shaped=len(sys.argv)>4 and sys.argv[4]=="shaped"
R=json.load(open(rates))
rowset=set(json.load(open(sys.argv[5]))) if len(sys.argv)>5 else None
p=D+"/packs/world.json"
W=json.load(open(p,encoding="utf-8"))
weak=re.compile(r"not-repeats|^digits|^id-shape")
n=m=0
for e in W:
    e.pop("personRow",None);e.pop("shapedRow",None)
    c=e.get("check","")
    if not e.get("context"): continue
    if rowset is not None:
        if e["id"] in rowset and e["id"] not in ("za-driver-licence","de-driving-licence") and c and not weak.search(c) and (e["id"] not in R or R[e["id"]]<=0.015): e["personRow"]=True;n+=1
        continue
    if shaped: e["shapedRow"]=True;m+=1
    if thr>=1:
        e["personRow"]=True;n+=1;continue
    if not c or weak.search(c): continue
    if e["id"] in ("az-fin","ec-cedula"): continue
    if e["id"] in R and R[e["id"]]<=thr:
        e["personRow"]=True;n+=1
json.dump(W,open(p,"w",encoding="utf-8"),indent=1,ensure_ascii=False)
print("personRow",n,"shaped",m,"of",len(W))
