# Migração PED Pituba (relato do Coord. Ribeiro em 2026-11-04). Uso: python3 este.py [--apply]
# Rodar com o container PARADO (o server mantém os JSON em memória e sobrescreveria).
#  - Lucas Lopes Pimentel: Grupo 1 A -> Grupo 2 A (fica só no integral/G2 A)
#  - Luih Lima Sales de Oliveira: Grupo 4 A -> Grupo 3 A
#  - 5º Ano B da Pituba (Bryan, Heitor) = alunos do COC Horto cadastrados por engano -> excluídos
# Registros movidos levam texto/desenho/status pra chave nova; a chave antiga vira lápide
# (removed:true) pra que nenhum navegador recrie o aluno na turma antiga.
import json, re, unicodedata, os, sys, shutil, time
D = '/var/lib/fliped/data'; U = 'ped-pituba'
MOVE = {  # norm(nome) -> (turma antiga, turma nova)
    'lucas lopes pimentel': ('Grupo 1 A', 'Grupo 2 A'),
    'luih lima sales de oliveira': ('Grupo 4 A', 'Grupo 3 A'),
}
REMOVE_TURMAS = {'5º Ano B', '5º Ano A', '5º Ano'}

def norm(s):
    s = unicodedata.normalize('NFD', str(s or '').lower())
    s = ''.join(c for c in s if unicodedata.category(c) != 'Mn')
    return re.sub(r'\s+', ' ', s).strip()
def skey(*v):
    out = []
    for x in v:
        x = unicodedata.normalize('NFD', str(x or '')); x = ''.join(c for c in x if not (0x300 <= ord(c) <= 0x36f))
        x = x.replace('º', 'o').replace('°', 'o').replace('ª', 'a')
        out.append(re.sub(r'\s+', ' ', x.strip().lower()))
    return '|'.join(out)

DRY = '--apply' not in sys.argv
now = time.strftime('%Y-%m-%dT%H:%M:%S.000Z', time.gmtime())
st = json.load(open(f'{D}/students.json', encoding='utf-8'))
print('students.json:', len(st), 'registros')

print('\n== Diagnóstico PED Pituba (Lucca/Lucas/Luih/5º ano) ==')
for k, v in sorted(st.items()):
    if v.get('unit') == U and (any(n in norm(v.get('name')) for n in ('lucca jordao', 'lucas', 'luih', 'luíh')) or '5' in (v.get('turma') or '') and 'ano' in norm(v.get('turma'))):
        print(' ', k, '| hasDrawing=', v.get('hasDrawing'), '| link=', v.get('driveLink'), '| texto=', bool(v.get('storyText')), '| removed=', v.get('removed'), '| upd=', v.get('updatedAt'))

ops = []
for k, v in list(st.items()):
    if v.get('unit') != U or v.get('removed'):
        continue
    n = norm(v.get('name'))
    if n in MOVE and v.get('turma') != MOVE[n][1]:
        nova = MOVE[n][1]
        k2 = skey(U, nova, v['name'])
        dest = st.get(k2, {})
        moved = {**dest, **v, 'turma': nova, 'updatedAt': now, '_migratedFrom': v.get('turma')}
        if dest.get('hasDrawing'): moved['hasDrawing'] = True
        if dest.get('storyText') and not v.get('storyText'): moved['storyText'] = dest['storyText']
        for f in ('removed', 'removedAt', 'removedBy'): moved.pop(f, None)
        st[k2] = moved
        st[k] = {'unit': U, 'turma': v.get('turma'), 'name': v['name'], 'removed': True, 'removedAt': now, 'removedBy': 'migracao-2026-11-04', 'movedTo': k2, 'updatedAt': now}
        ops.append(f'MOVE {k} -> {k2}')
    elif v.get('turma') in REMOVE_TURMAS:
        st[k] = {**v, 'removed': True, 'removedAt': now, 'removedBy': 'migracao-2026-11-04', 'updatedAt': now}
        ops.append(f'REMOVE {k}')

# Lápides nas chaves antigas mesmo sem registro (navegadores com cache antigo)
for nome, (velha, _) in (('Lucas Lopes Pimentel', MOVE['lucas lopes pimentel']), ('Luih Lima Sales de Oliveira', MOVE['luih lima sales de oliveira'])):
    k = skey(U, velha, nome)
    if k not in st:
        st[k] = {'unit': U, 'turma': velha, 'name': nome, 'removed': True, 'removedAt': now, 'removedBy': 'migracao-2026-11-04', 'updatedAt': now}
        ops.append(f'TOMBSTONE {k}')
for nome in ('Bryan Silva Conceição', 'Heitor Ritchel Costa Prazeres de Sales'):
    k = skey(U, '5º Ano B', nome)
    if k not in st:
        st[k] = {'unit': U, 'turma': '5º Ano B', 'name': nome, 'removed': True, 'removedAt': now, 'removedBy': 'migracao-2026-11-04', 'updatedAt': now}
        ops.append(f'TOMBSTONE {k}')

print('\n== Operações ==')
for o in ops: print(' ', o)
if DRY:
    print('\nDRY RUN — nada gravado. Rode com --apply para gravar.'); sys.exit()
bak = f'{D}/students.json.bak-{int(time.time())}'
shutil.copy2(f'{D}/students.json', bak)
tmp = f'{D}/students.json.tmp'
json.dump(st, open(tmp, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
os.replace(tmp, f'{D}/students.json')
print('\nGRAVADO. Backup:', bak)
