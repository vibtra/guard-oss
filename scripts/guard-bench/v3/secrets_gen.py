import json,re,sys,tomllib
S=sys.argv[1];OUT=sys.argv[2]
c=tomllib.load(open(S+'/oss/gitleaks/config/gitleaks.toml','rb'))
have={'aws-access-token','github-pat','github-fine-grained-pat','github-app-token','openai-api-key','anthropic-api-key','slack-token','stripe-access-token','gcp-api-key','gcp-oauth-token','gcp-client-secret','slack-webhook-url','private-key','jwt','sendgrid-api-token'}
skip={'generic-api-key'}
out=[]
for r in c['rules']:
    if r['id'] in have or r['id'] in skip or 'path' in r or 'regex' not in r:continue
    try:re.compile(r['regex'].replace('(?i)',''))
    except Exception:pass
    if re.search(r'\(\?[=!<]',r['regex']):continue
    out.append({'id':r['id'],'label':r.get('description','a secret')[:80],'source':'gitleaks (MIT)','patterns':[r['regex']],'keywords':[k.lower() for k in r.get('keywords',[])],'entropy':r.get('entropy',0),'group':r.get('secretGroup',0)})
g=len(out)
txt=open(S+'/oss/pipelock/internal/config/dlp_patterns.go').read()
extra={'fireworks':r'\bfw_[A-Za-z0-9]{24,}\b','huggingface-token':r'\bhf_[A-Za-z0-9]{30,}\b','groq-api-key':r'\bgsk_[A-Za-z0-9]{32,}\b','xai-api-key':r'\bxai-[A-Za-z0-9]{32,}\b','replicate-token':r'\br8_[A-Za-z0-9]{32,}\b','together-key':r'\btgp_v1_[A-Za-z0-9_-]{32,}\b','postgres-url':r'(?i)\bpostgres(?:ql)?://[^\s:@/]+:[^\s@/\[\*<$\{]{3,}@[^\s]+','mysql-url':r'(?i)\bmysql://[^\s:@/]+:[^\s@/\[\*<$\{]{3,}@[^\s]+','mongodb-url':r'(?i)\bmongodb(?:\+srv)?://[^\s:@/]+:[^\s@/\[\*<$\{]{3,}@[^\s]+','redis-url':r'(?i)\brediss?://[^\s:@/]*:[^\s@/\[\*<$\{]{3,}@[^\s]+','credential-url':r'(?i)\bhttps?://[^\s:@/]+:[^\s@/\[\*<$\{]{3,}@[A-Za-z0-9.-]+','aws-secret-labelled':r'(?i)aws.{0,20}secret.{0,20}[=:]\s*["\']?([A-Za-z0-9/+=]{40})','vault-token':r'\bhvs\.[A-Za-z0-9_-]{24,}\b','bitcoin-wif':r'\b(?:5[1-9A-HJ-NP-Za-km-z]{50}|[KL][1-9A-HJ-NP-Za-km-z]{51})\b','extended-private-key':r'\b[xyz]prv[1-9A-HJ-NP-Za-km-z]{100,}\b'}
for k,v in extra.items():
    out.append({'id':k,'label':'a credential ('+k+')','source':'pipelock (Apache-2.0)','patterns':[v],'keywords':[],'entropy':0,'group':0})
lab=[('api-key-labelled',r'(?i)(?:api[ _-]?key|apikey|api[ _-]?token|access[ _-]?token|auth[ _-]?token|secret[ _-]?key|client[ _-]?secret|api[ -]?nyckel|api[ -]?schlüssel|clé api|tokenid)[\'"`*\s]*(?:[:=]|is|>|such as|:\s*`)[\'"`*\s]*([A-Za-z0-9_\-+]{8,})',2.8),('password-labelled',r'(?i)(?:password|passwd|pwd|passcode|contraseña|passwort|mot de passe|lösenord|wachtwoord|enable secret(?: [0-9])?)[\'"`*\s\\]*(?:[:=]|is|>)[\'"`*\s\\]*([^\s\'"`<>,;]{8,})',2.5)]
for i,p,en in lab:
    out.append({'id':i,'label':'a labelled credential','source':'vibtra','patterns':[p],'keywords':[],'entropy':en,'group':1,'mixed':True})
for r in out:r['patterns']=[x.replace('bedrock-api-key-YmVk','bedrock-api-key-[Y]mVk') for x in r['patterns']]
json.dump(out,open(OUT,'w'),indent=0,ensure_ascii=False);print('gitleaks',g,'total',len(out))
