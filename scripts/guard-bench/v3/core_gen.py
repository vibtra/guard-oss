import json,sys
def dg(*g):
    t=sum(g);return '[ .\\-/\\n]?'.join('[0-9]{%d}'%x for x in g)+'|(?:[0-9] ){%d}[0-9]'%(t-1)
tok=r'[A-Za-z0-9]+(?:[-./][A-Za-z0-9]+){0,5}'
spaced=r'(?:[A-Za-z]{1,8}[-/]){0,3}[A-Za-z]{0,6}[0-9][A-Za-z0-9]*(?:[-./ ][A-Za-z]{0,2}[0-9][A-Za-z0-9]*){0,7}'
month=r'(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?'
numeric=r'[0-9]{1,2}[/\-. ][0-9]{1,2}[/\-. ][0-9]{2,4}|[0-9]{4}[/\-.][0-9]{1,2}[/\-.][0-9]{1,2}'
named=r'[0-9]{1,2}(?:st|nd|rd|th)?\s+'+month+r',?\s+[0-9]{2,4}|'+month+r'\s+[0-9]{1,2}(?:st|nd|rd|th)?,?\s+[0-9]{2,4}'
E=[]
def e(id,label,country,group,patterns,**k):
    x=dict(id=id,label=label,country=country,group=group,source=k.pop('source','vibtra'),patterns=patterns);x.update(k);E.append(x)
ssnw=['ssn','ssns','ssn no','social security','social security number','social security numbers','social security no','socialsecuritynumber','ss#','ss no']
e('us-ssn-formatted','a US Social Security number','US','government-id',[r'[0-9]{3}-[0-9]{2}-[0-9]{4}'],check='us-ssn',bounds='number')
e('us-ssn','a US Social Security number','US','government-id',[dg(3,2,4)],check='us-ssn',context=ssnw,before=80,after=30,bounds='number',noDecimal=True)
e('us-ssn-spaced','a US Social Security number','US','government-id',[r'[0-9]{3} [0-9]{3} [0-9]{3}'],context=ssnw,before=80,after=30,bounds='number')
e('us-itin','a US ITIN','US','tax-id',[r'9[0-9]{2}-[0-9]{2}-[0-9]{4}',dg(3,2,4)],check='us-itin',context=['itin','itins','taxpayer identification','individual taxpayer'],bounds='number',noDecimal=True)
rout=['routing','aba','rtn','ach','wire','direct deposit','checking','routing number','bank routing','routingnumber','routningsnummer','routningsnumret','bankroutingnummer','número de ruta','numero de ruta','numéro de routage','numero di routing','routeringsnummer','bankleitzahl','blz']
e('us-routing','a US bank routing number','US','bank',[dg(9)],check='us-routing',context=rout,bounds='number',noDecimal=True)
e('us-npi','a US National Provider Identifier','US','health',[dg(10)],check='us-npi',context=['npi','prescriber','referring','provider'],bounds='number',noDecimal=True)
e('us-mbi','a US Medicare Beneficiary Identifier','US','health',[r'\b[1-9][AC-HJKMNP-RT-Y][AC-HJKMNP-RT-Y0-9][0-9][- .]?[AC-HJKMNP-RT-Y][AC-HJKMNP-RT-Y0-9][0-9][- .]?[AC-HJKMNP-RT-Y]{2}[0-9]{2}\b'],source='vibtra; format from CMS')
e('au-bsb','an Australian BSB','AU','bank',[r'[0-9]{3}[- .]?[0-9]{3}'],context=['bsb'],before=40,after=20,bounds='number')
e('au-ihi','an Australian Individual Healthcare Identifier','AU','health',[dg(4,4,4,4)],check='au-ihi',bounds='number',noDecimal=True)
e('au-crn','a Centrelink Customer Reference Number','AU','government-id',[r'\b[0-9]{3}[ -]?[0-9]{3}[ -]?[0-9]{3}[ -]?[A-Z]\b'],context=['crn','centrelink','customer reference','services australia'])
e('iban','an IBAN','','bank',[r'\b[A-Z]{2}[0-9]{2}(?:[ -]?[A-Z0-9]){11,30}\b'],check='iban',source='pipelock; validator.js')
acct=['account number','account numbers','account no','account #','acct','acct no','acct number','accountnumber','a/c','bank account','bban','account','kontonummer','bankkonto','bankkontonummer','numero de cuenta','número de cuenta','cuenta bancaria','numero di conto','conto corrente','rekeningnummer','bankrekeningnummer','numéro de compte','compte bancaire']
e('bank-account','a bank account number','','bank',[spaced],check='digits5',context=acct,before=60,after=0,bounds='token',anchored=True)
e('bank-account-prefixed','a bank account number','','bank',[r'\bACCT-[0-9]{5,}\b'])
pw=['passport','passport number','passport no','passportnumber','passportno','travel document','reisepass','reisepassnummer','passeport','numéro de passeport','numero de passeport','pasaporte','número de pasaporte','numero de pasaporte','passaporto','passaporte','numero di passaporto','paspoort','paspoortnummer','passnummer','pass nr','passnr']
e('passport','a passport number','','government-id',[r'\b[A-Za-z]{0,2}[0-9]{6,9}\b'],context=pw,before=60,after=20,anchored=True)
lic=['licence','license','licences','licenses','driver licence','driver license','licence number','license number','licensenumber','driverlicense','driverlicence','driverslicense','driver license number','drivers licence','drivers license','führerschein','fuhrerschein','führerscheinnummer','permis de conduire','numéro de permis','carnet de conducir','licencia de conducir','licencia','patente','patente di guida','rijbewijs','rijbewijsnummer','körkort','körkortsnummer','certificate number','certification number','certificate license number','permit number','cert']
e('licence','a driver licence or licence number','','government-id',[spaced],check='digits4',context=lic,before=50,after=10,anchored=True)
e('licence-prefixed','a licence or certificate number','','government-id',[r'\b(?:LIC|CERT)-[A-Z0-9]{5,}\b'])
e('mrn','a medical record number','','health',[spaced],check='digits4',context=['medical record number','medical record','medical records','medical record numbers','medicalrecordnumber','mrn','mrns','record number','patient id','patient number','patientid','chart number','the chart for'],before=60,after=0,bounds='token',anchored=True)
e('mrn-prefixed','a medical record number','','health',[r'\b(?:MRN|MED)-?[0-9]{5,}\b'])
hp=['health plan beneficiary number','beneficiary number','beneficiary numbers','beneficiarynumber','member id','member number','memberid','health plan','hpbn','subscriber id','insurance id','policy number','policy no','policynumber','polisnummer']
e('health-plan','a health plan member number','','health',[spaced],check='digits4',context=hp,before=60,after=0,bounds='token',anchored=True)
e('health-plan-prefixed','a health plan member number','','health',[r'\bHPBN-[0-9]{5,}\b'])
nid=['national id','national ids','nationalid','national identification','national identity','national insurance','id number','identity number','identity card','id card','identification number','personalausweis','carte d\'identité','dni','nif','nie','cédula','codice fiscale','personnummer','burgerservicenummer','bsn']
e('national-id','a national ID number','','government-id',[spaced],check='digits6',context=nid,before=40,after=0,anchored=True)
tax=['tax id','tax ids','taxid','tax identification','tax identification number','taxpayer identification','taxpayer id','employer identification number','tin','ein','fein','vat id','steuernummer','steuer id','steueridentifikationsnummer','parcel id','parcel number']
e('tax-id','a tax identification number','','tax-id',[spaced],check='digits6',context=tax,before=40,after=0,anchored=True)
birth=['dob','d.o.b','d.o.b.','date of birth','dateofbirth','birth date','birthdate','birthday','geburtsdatum','geboren am','date de naissance','datedenaissance','né le','née le','fecha de nacimiento','fechadenacimiento','nacido el','nacida el','data di nascita','datadinascita','nato il','nata il','geboortedatum','födelsedatum','född den']
e('date-of-birth','a date of birth','','personal',[numeric,named],context=birth,before=40,after=0)
e('date-of-birth-born','a date of birth','','personal',[numeric],context=['born','born on','birth','né','née','nacido','nacida','geboren','född'],before=25,after=0)
e('uk-nino-labelled','a UK National Insurance number','GB','government-id',[r'\b[A-Z]{2} ?[0-9]{2} ?[0-9]{2} ?[0-9]{2} ?[A-D]?[A-Z]?\b',r'\b[A-Z]{2} ?[0-9]{6} ?[A-Z]\b'],context=ssnw+['nino','national insurance','ni number'],before=60,after=0)
card=['card','credit card','debit card','card number','cardnumber','credit debit card','kortnummer','creditcard','kreditkarte','kreditkartennummer','carte de crédit','carta di credito','tarjeta de crédito','tarjeta','kreditkort']
e('card-labelled','a payment card number','','bank',[r'(?:[0-9][ -]?){11,18}[0-9]'],check='luhn',context=card,before=50,after=0,bounds='number')
e('au-tfn-8','an Australian tax file number','AU','tax-id',[r'[0-9]{3}[ -]?[0-9]{3}[ -]?[0-9]{2}'],context=['tfn','tax file','tax file number'],before=40,after=0,bounds='number')

import os,re
world=json.load(open(os.path.join(os.path.dirname(sys.argv[1]),'world.json'),encoding='utf-8')) if os.path.exists(os.path.join(os.path.dirname(sys.argv[1]),'world.json')) else []
ambiguous={'rfc','nas','spi','utr','nit','tin','inn','rut','nic','sss','taj','sars','run','res','pnr','pan','pin','fin','epic','sin','rc','rg','cc','ci','cie','cns','pis','spi','nas','nip','dea','ird','ccc','frn','cni','naf','npa','kra','iin','uan','icbc','number','no','id','code'}
generic=['tax number','tax reference number','income tax number','taxpayer number','tax identification number','tax code','personal number','personal id','personal identity number','personal code','birth number','national number','citizen card number','citizen service number','citizen id','resident id','residence id','residence permit','foreigner number','foreign resident number','social security number','social security no','social insurance number','health insurance number','insurance number','pupil number','unique pupil number','voter key','voter id','voter number','elector key','driver number','driver id','id card number','identity card number','identity document','passport number',
'pgn','ruc','nit','nuip','nrt','peid','gsis','gsis number','gsis bp no','imss','imss number','nss','run','dimex','upn','nifp','nuit','cui','curp','rfc','kvnr','niss','sv nummer','rv nummer','stnr','st nr','sofinummer','bis nummer','numéro bis','eid kaartnummer','onderwijsnummer','documentnummer','identiteitskaartnummer','paspoortnummer','reisepassnummer','versichertennummer','personenidentifikationsnummer','sozialversicherungsnummer','personnr','fnr','kontonr','p.k.','a.k.','kt.','č. ú.','ת.ז.','מספר זהות','ΑΔΤ','ЛНЧ','лнч','lnch','pag ibig number','ric number','clave de elector','clave bancaria uniforme','cbu','número de identificación tributaria','número de identificación fiscal','número de identidad','número de afiliación','número de pasaporte','pasaporte','número único de identificação tributária','número de registre tributari','registro federal de contribuyentes','registro único del contribuyente','registro geral','documento nacional de identidad','carnet de identidad','cédula física','cédula','numéro d identification fiscale','numéro d identification national','numéro de registre national','numéro de passeport','passeport n°','passeport','numero carta d identità','személyi szám','személyi azonosító','bankovní účet','број на пасош','pasos','паспорт','податковий номер','личен номер на чужденец','единен граждански номер','αριθμός δελτίου ταυτότητας','เลขประจำตัวผู้เสียภาษี','เลขประจำตัวประชาชน','số cccd']
demonyms=['afghan','albanian','algerian','andorran','argentine','argentinian','armenian','australian','austrian','azerbaijani','bangladeshi','belarusian','belgian','bolivian','bosnian','brazilian','british','bulgarian','canadian','chilean','chinese','colombian','costa rican','croatian','cuban','cypriot','czech','danish','dominican','dutch','ecuadorian','egyptian','emirati','estonian','finnish','french','georgian','german','ghanaian','greek','guatemalan','guinean','honduran','hungarian','icelandic','indian','indonesian','iranian','iraqi','irish','israeli','italian','jamaican','japanese','jordanian','kazakh','kenyan','korean','kuwaiti','latvian','lebanese','libyan','liechtenstein','lithuanian','luxembourg','macedonian','malaysian','maltese','mauritian','mexican','moldovan','mongolian','montenegrin','moroccan','mozambican','nepali','new zealand','nicaraguan','nigerian','norwegian','omani','pakistani','panamanian','paraguayan','peruvian','philippine','filipino','polish','portuguese','qatari','romanian','russian','salvadoran','saudi','serbian','singaporean','slovak','slovenian','south african','spanish','sri lankan','swedish','swiss','taiwanese','tanzanian','thai','tunisian','turkish','ugandan','ukrainian','uruguayan','venezuelan','vietnamese','zambian','zimbabwean']
generic+=[d+' '+a for d in demonyms for a in ('rg','nit','ruc','inn','tin','fin','cpf','dni','curp','rfc','ic','nuit','ssn','pin','uid','vid','nin','nic')]+[d+' id' for d in demonyms]+[d+' id number' for d in demonyms]+['nic','nid','bis number','belgian bis number','bank account number','national identity card','malaysian ic','ic number','student number','inn','tin','a k','p k','ipn','peid','stnr','citizen number','sa id','ic number']
vocab=sorted({w.lower().replace('_',' ').replace('-',' ') for x in world for w in x.get('context',[])}|set(generic))
ambiguous|={l.strip().lower() for l in open(os.path.join(os.path.dirname(os.path.abspath(__file__)),'ambiguous.txt'),encoding='utf-8') if l.strip()}
vocab=[w for w in vocab if w not in ambiguous and len(w)>=3 and w not in ('chino','patente','gratin')]
acronyms=[w for w in vocab if w.isalpha() and len(w)<=5]
vocab=[w for w in vocab if w not in acronyms]
strongwords={w.lower().replace('_',' ').replace('-',' ') for x in world if x.get('check') and not re.search(r'not-repeats|^digits|^id-shape',x['check']) for w in x.get('context',[])}
acronyms=[w for w in acronyms if w not in strongwords]+['dni','nuip']
vocab+=['cedula','cedula fisica','cedula juridica','cedula de identidad','numero de dni','número de dni','identification fiscale','identifiant fiscal','numero d identification','numéro d identification','numero d identification fiscale']
dotted=['.'.join(w) for w in acronyms+[x for x in sorted(strongwords) if x.isascii() and x.isalpha() and 3<=len(x)<=5 and x not in ambiguous] if w.isascii() and w.isalpha() and 3<=len(w)<=5]
vocab+=dotted+['tax no','tax no.','tax ref','tax ref no','tax reference','taxpayer no','contribuyente','registro de contribuyente','registro unico','registro único','clave afip','clave fiscal','documento','doc no','doc number','personenidentifikations nr','personen id','bisnummer','bis nummer','bis number','belgian bis number']
stems=['personal','personal id','personal identity','personal identification','foreigner','foreigner id','foreign resident','resident','residence','residency','citizen','citizen id','citizenship','identity','identification','national','national identity','national identification','tax','taxpayer','tax payer','tax registry','taxpayer registry','tax registration','tax reference','fiscal','social security','social insurance','pension','national insurance','health insurance','health card','health service','patient','medical record','voter','elector','electoral','driver','drivers','driver s','driving','driving licence','driving license','licence','license','lic','cdl','dvla','passport','travel document','identity card','id card','electronic id','electronic identity','civil registry','civil id','birth registration','population registry','employee tax','paid preparer','iban','bank transfer','bank account','bank acct','sort code']
sufs=['no','no.','num','num.','nr','nr.','number','#','id','code','ref','reference']
drop={'national id code','tax code','resident code','passport code','license code','licence code','driver id','driver no','driver no.','tax ref','national no','national number','resident no','tax no.','id id','patient id','patient no','patient no.','patient number','patient code','health service id','health service code','voter id code'}
vocab+=[w for w in (s+' '+x for s in stems for x in sufs) if w not in drop]
idvalue=r'[A-Za-z]{0,6}[-]?[0-9][A-Za-z0-9]*(?:[-./ ][A-Za-z]{0,2}[0-9][A-Za-z0-9]*){0,7}(?:-?[A-Za-z])?|[0-9A-Z]*[0-9][0-9A-Z]*'
e('labelled-id','a labelled personal identifier','','government-id',[idvalue],check='id-shape',context=vocab,before=36,after=32,bounds='token',anchored=True)
e('labelled-id-cell','a labelled personal identifier','','government-id',[idvalue],check='id-shape',context=['nit','inn','tin','rut','cui','nic','fin','sin','vid','rg','cie','ci','pin','pan'],before=1,after=0,bounds='token',anchored=True,cellOnly=True)
e('labelled-id-acronym','a labelled personal identifier','','government-id',[idvalue],check='id-shape',context=acronyms,before=12,after=20,bounds='token',anchored=True,upperGap=36)
for x in E:
    if x['id'] in ('national-id','tax-id','licence','passport') :
        x['context']=[w for w in x['context'] if not (w.isalpha() and len(w)<=5 and w not in ('ein','fein') and (w in strongwords or w in ('tin','nss','nif','bsn','nid')))]
    if x['id']=='labelled-id-acronym':
        x['context']=[w for w in x['context'] if w not in ('nss','nid','cui')]
    if x['id']=='labelled-id-cell':
        x['context']=sorted(set(x['context'])|{'nss','nid','tfn','ssn','bsn','nif','afm'})
for x in E:
    if x['id'] in ('health-plan','health-plan-prefixed'):
        x['label']='an insurance or health plan number'
    if x['id']=='licence':
        x['context']=[w for w in x['context'] if w!='cert']+['dl#','dl no','dl number']
for x in E:
    if x['id']=='labelled-id':
        x['context']=[w for w in x['context'] if w not in ('medicare','medicare number','medicare no','medicare card','medicare card number','tax file number','tax file no','tax file','m.e.d','t.f.n','tfn')]
json.dump(E,open(sys.argv[1],'w'),indent=1,ensure_ascii=False)
print(len(E))
