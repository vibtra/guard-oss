#!/usr/bin/env python3
"""Disposable production-image boot + Postgres contract tests; never touches host trust."""
import os, secrets, subprocess, tempfile, time, json, urllib.request, urllib.error
from pathlib import Path
root=Path(__file__).resolve().parent.parent
name='guard-smoke-'+secrets.token_hex(5); network=name; pg=name+'-pg'; app=name+'-app'
password=secrets.token_hex(24)
def run(args,**kw):return subprocess.run(args,check=True,text=True,capture_output=True,**kw).stdout.strip()
def ready(url):
 for _ in range(90):
  try:
   with urllib.request.urlopen(url,timeout=2) as r:
    if r.status==200:return
  except (OSError,urllib.error.HTTPError):pass
  time.sleep(.5)
 raise RuntimeError('container did not become ready')
def status(url):
 try:
  with urllib.request.urlopen(url,timeout=5) as r:return r.status
 except urllib.error.HTTPError as e:return e.code
try:
 run(['docker','network','create',network])
 run(['docker','run','-d','--name',pg,'--network',network,'-p','127.0.0.1::5432','-e','POSTGRES_DB=guard','-e','POSTGRES_USER=guard','-e','POSTGRES_PASSWORD='+password,'postgres:16-alpine'])
 for _ in range(90):
  if subprocess.run(['docker','exec',pg,'pg_isready','-U','guard','-d','guard'],capture_output=True).returncode==0:break
  time.sleep(.5)
 else:raise RuntimeError('Postgres not ready')
 port=run(['docker','port',pg,'5432']).split(':')[-1]
 env=os.environ.copy();env['VIBTRA_TEST_DATABASE_URL']=f'postgres://guard:{password}@127.0.0.1:{port}/guard'
 test=subprocess.run(['pnpm','--filter','@vibtra/registry','test'],cwd=root,env=env)
 if test.returncode:raise RuntimeError('Postgres Guard suites failed')
 with tempfile.TemporaryDirectory(prefix='guard-smoke-') as tmp:
  f=Path(tmp)/'env';f.write_text('\n'.join(['DATABASE_URL='+f'postgres://guard:{password}@{pg}:5432/guard','REGISTRY_BASE_URL=http://localhost:4700','REGISTRY_SESSION_SECRET='+secrets.token_hex(32),'VIBTRA_VAULT_KEY='+secrets.token_hex(32),'REGISTRY_OIDC_CLIENT_ID=smoke.invalid','REGISTRY_OIDC_CLIENT_SECRET='+secrets.token_hex(32)])+'\n');f.chmod(0o600)
  run(['docker','run','-d','--name',app,'--network',network,'-p','127.0.0.1::4700','--env-file',str(f),os.environ.get('GUARD_IMAGE','vibtra-guard:vib24')])
  port=run(['docker','port',app,'4700']).split(':')[-1];base='http://127.0.0.1:'+port
  ready(base+'/healthz')
  for route,expected in [('/healthz',200),('/login',200),('/start',200),('/pricing',200),('/smoke/guard',200),('/api/console/guard/settings',401),('/api/console/tools',404),('/api/console/workspaces',404)]:
   actual=status(base+route)
   assert actual==expected,(route,actual,expected)
  print('PASS: production container, migrations, real Postgres, Guard assets/auth boundary; OAuth login not exercised')
finally:
 for c in [app,pg]:subprocess.run(['docker','rm','-f','-v',c],capture_output=True)
 subprocess.run(['docker','network','rm',network],capture_output=True)
