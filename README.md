# INSAWEB – Backend (API)

API de INSAWEB para INSALUD: Node 20 + Express + MySQL 8. El frontend está en el repositorio
[insaweb-frontend](https://github.com/TeamInsalud/insaweb-frontend).

| Módulo | Formulario (`usuariofor.for_nom`) | Endpoints |
|---|---|---|
| Sesión | — | `POST /api/login`, `GET /api/sesion` |
| Consulta Nómina | `CNFO1203` | `/api/trabajador*`, `/api/trabajadores/buscar` |
| Reportes | `COM_FOR` | `GET /api/reportes/otros-conceptos?mes=` |
| Master RRHH | `FONO2301` | `/api/rrhh/ficha/*` |
| Salud | — | `GET /api/salud` (200 si hay conexión con MySQL) |

## Desarrollo
```bash
npm install
cp .env.example .env   # completar DB_* y JWT_SECRET
npm run dev            # http://localhost:3001
```

## Despliegue en Coolify
- **Build Pack:** Dockerfile (incluido). **Puerto:** 3001. **Health check:** `/api/salud`.
- **Variables de entorno** (ver `.env.example`): `DB_HOST=10.10.0.4`, `DB_USER`, `DB_PASSWORD`,
  `DB_NAME`, `JWT_SECRET` (obligatorio, uno nuevo), `TRUST_PROXY=true`.
- `CORS_ORIGIN` solo si el frontend se publica en otro nombre o puerto; si el frontend envía `/api`
  a este servicio por su propio proxy (configuración recomendada), se deja vacío.

El usuario de MySQL necesita acceso desde el servidor de aplicaciones (no solo desde `localhost`) y
permiso `INDEX` sobre la base.

## Índices automáticos
Al arrancar, revisa que la base activa (`DB_NAME`) tenga los índices que necesita
(`src/mantenimiento.js`) y crea los que falten, en segundo plano:

- `noda2800 (act_nro, ded_nro)` → `idx_noda2800_act`, usado por el reporte Otros Conceptos Gastos de Personal.

La creación tarda ≈20 s (la tabla queda bloqueada mientras tanto); el resultado queda en el log con el
prefijo `[índices]`.

## Plantillas
`plantillas/` contiene la plantilla del reporte Otros Conceptos Gastos de Personal; forma parte del código.
