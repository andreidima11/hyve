# Memini Bridge

Memini Bridge este o aplicație local-first pentru orchestrarea unui asistent personal cu memorie, integrare Home Assistant, automatizări și o interfață web proprie. Proiectul combină un backend FastAPI, stocare locală pentru context și un frontend modular pentru chat, conferințe și administrare.

## Ce face

- oferă o interfață web pentru chat, memorie și administrare
- poate integra Home Assistant pentru control și context din casă
- rulează fluxuri de automatizare și reminder-e programate
- păstrează context semantic local pentru căutare și reutilizare
- include mod de conferință pentru fluxuri multi-agent și task orchestration
- suportă modele locale sau remote, în funcție de configurare

## Stack

- Python 3.12
- FastAPI
- SQLAlchemy
- ChromaDB
- APScheduler
- httpx
- Tailwind CSS
- JavaScript modular în `static/js`

## Cerințe

- Python 3.12
- Node.js doar pentru rebuild-ul CSS
- un `config.json` valid pentru mediul local
- un model configurat local sau remote, dacă vrei funcțiile de chat

## Pornire rapidă

### 1. Creează mediul Python

```bash
python3 -m venv venv
source venv/bin/activate
pip install --upgrade pip
pip install -r requirements.txt
pip install -r requirements-dev.txt
```

### 2. Configurează mediul

- pornește de la `.env.example`
- completează `config.json` cu valorile locale necesare
- vezi [CONFIG.md](CONFIG.md) pentru opțiunile de configurare

Pentru startup strict sau medii de release:

- `MEMINI_SECRET_KEY` trebuie setat explicit
- endpoint-ul modelului și numele modelului trebuie configurate
- accesul anonim trebuie să rămână dezactivat

### 3. Rulează aplicația

```bash
source venv/bin/activate
python main.py
```

Alternativ:

```bash
./start.sh
```

Implicit, aplicația pornește pe `http://localhost:8082`.

## Testare

Rulează testele:

```bash
source venv/bin/activate
python -m pytest
```

Rulează verificările de release:

```bash
source venv/bin/activate
python scripts/release_gate.py
```

## Frontend și CSS

Pentru build CSS:

```bash
npm install
npm run css:build
```

Pentru watch:

```bash
npm run css:watch
```

## Structură

- `main.py` — entrypoint FastAPI și wiring principal
- `auth.py` — autentificare, token-uri și politici de acces
- `settings.py` — configurare, overlay din environment și validare
- `routers/` — endpoint-uri FastAPI
- `brain/` — logică de orchestrare, tool-uri și memorie
- `static/js/` — frontend modular
- `static/css/` — stiluri și build output
- `templates/` — template-uri HTML
- `tests/` — teste și regresii

## Note pentru publicare

- repo-ul nu include date locale, baze sqlite, sesiuni, loguri sau chei sensibile
- valorile secrete trebuie injectate prin environment, nu păstrate în repo
- fișierele de runtime și datele generate local sunt excluse prin `.gitignore`

## Documentație utilă

- [CONFIG.md](CONFIG.md)

## Status

Proiect activ, orientat pe uz local și integrare practică între automation, memory tooling și interfață web.
