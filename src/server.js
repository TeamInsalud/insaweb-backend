import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { pool } from './db.js';
import {
  signToken,
  requireAuth,
  requirePermiso,
  pantallasDeUsuario,
  PANTALLA_CONSULTA,
  PANTALLA_REPORTES,
  PANTALLA_RRHH,
} from './auth.js';
import { generarModelo, analizarArchivo, aplicarCambios, nombreEquipo } from './rrhh/fichaPersonal.js';
import { generarOtrosConceptos } from './reportes/otrosConceptos.js';
import { verificarIndices } from './mantenimiento.js';

// El secreto de las sesiones debe ser propio de cada instalación
if (!process.env.JWT_SECRET || process.env.JWT_SECRET.startsWith('cambie-este-secreto')) {
  console.error('ERROR: defina un JWT_SECRET propio en backend/.env (ver backend/.env.example)');
  process.exit(1);
}

const app = express();
// Solo si hay un proxy inverso delante (IIS, nginx…): así req.ip toma la IP real del cliente para la auditoría
// Acepta true, un número de saltos (1) o una lista de IPs/subredes (loopback, 10.10.0.0/24)
const trustProxy = String(process.env.TRUST_PROXY || '').trim();
if (trustProxy) {
  app.set('trust proxy', trustProxy === 'true' ? true : /^\d+$/.test(trustProxy) ? Number(trustProxy) : trustProxy);
}

// CORS solo si el frontend se publica en otro origen (otro nombre o puerto). Si el frontend envía /api al
// backend por su propio proxy (mismo origen), no hace falta y CORS_ORIGIN se deja vacío.
const origenesCors = String(process.env.CORS_ORIGIN || '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);
if (origenesCors.length) {
  // Content-Disposition: el frontend lo lee para nombrar los Excel descargados
  app.use(cors({ origin: origenesCors, exposedHeaders: ['Content-Disposition'] }));
}
app.use(express.json());

// Estado del servicio para Coolify / monitoreo: responde 200 si hay conexión con MySQL
app.get('/api/salud', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ estado: 'ok', baseDatos: 'ok' });
  } catch (err) {
    res.status(503).json({ estado: 'error', baseDatos: err.code || 'sin conexión' });
  }
});

// Toda consulta requiere sesión válida y permiso a la pantalla CNFO1203
const accesoConsulta = [requireAuth, requirePermiso(PANTALLA_CONSULTA)];

const trim = (v) => (typeof v === 'string' ? v.trim() : v);
const trimRow = (row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, trim(v)]));

// Nacionalidad + cédula de 8 dígitos (ceros a la izquierda) + "000"
export function componerCedula(nac, numero) {
  const n = String(nac || '').toUpperCase();
  const num = String(numero || '').trim();
  if (!['V', 'E', 'P'].includes(n)) throw new Error('Nacionalidad inválida');
  if (!/^\d{1,8}$/.test(num)) throw new Error('La cédula debe tener entre 1 y 8 dígitos');
  return `${n}${num.padStart(8, '0')}000`;
}

app.post('/api/login', async (req, res) => {
  const { cedula, clave } = req.body || {};
  if (!/^\d+$/.test(String(cedula || '')) || !clave) {
    return res.status(400).json({ message: 'Ingrese cédula y clave' });
  }
  try {
    const [rows] = await pool.query(
      'SELECT usu_ced, usu_cla, usu_nom, ubi_nom FROM usuario WHERE usu_ced = ? LIMIT 1',
      [Number(cedula)],
    );
    const u = rows[0];
    if (!u || trim(u.usu_cla) !== String(clave).trim()) {
      return res.status(401).json({ message: 'Cédula o clave incorrecta' });
    }
    const user = { cedula: u.usu_ced, nombre: trim(u.usu_nom), ubicacion: trim(u.ubi_nom) };
    res.json({ token: signToken(user), user });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Error de conexión con la base de datos' });
  }
});

// Sesión actual: datos del usuario y formularios (usuariofor.for_nom) que tiene asignados, para armar el menú
app.get('/api/sesion', requireAuth, async (req, res) => {
  try {
    const { cedula, nombre, ubicacion } = req.user;
    res.json({ user: { cedula, nombre, ubicacion }, pantallas: await pantallasDeUsuario(cedula) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Error consultando los permisos' });
  }
});

// Búsqueda por nombre: cada palabra escrita debe aparecer en tra_nom + tra_ape
app.get('/api/trabajadores/buscar', accesoConsulta, async (req, res) => {
  const palabras = String(req.query.q || '').trim().split(/\s+/).filter(Boolean).slice(0, 6);
  if (palabras.join('').length < 3) return res.json([]);
  try {
    const where = palabras.map(() => "CONCAT_WS(' ', tra_nom, tra_ape) LIKE ?").join(' AND ');
    const params = palabras.map((p) => `%${p.replace(/[\\%_]/g, '\\$&')}%`);
    const [rows] = await pool.query(
      `SELECT tra_ced, tra_nom, tra_ape FROM noda1100 WHERE ${where}
        ORDER BY tra_nom, tra_ape LIMIT 30`,
      params,
    );
    res.json(rows.map(trimRow));
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Error consultando la base de datos' });
  }
});

// Divisor de montos del preliminar según el pago "pp" (noda1600): quincenal (pag_cod "Q...") = 2
const DIVISOR_SQL = "IF(pp.pag_cod LIKE 'Q%', 2, 1)";

app.get('/api/trabajador', accesoConsulta, async (req, res) => {
  let cedula;
  try {
    // "ced" = cédula ya compuesta (selección desde la búsqueda por nombre)
    const ced = String(req.query.ced || '').toUpperCase();
    if (ced && !/^[VEP]\d{11}$/.test(ced)) throw new Error('Cédula inválida');
    cedula = ced || componerCedula(req.query.nac, req.query.numero);
  } catch (err) {
    return res.status(400).json({ message: err.message });
  }
  try {
    const [personal] = await pool.query(
      `SELECT tra_ced, tra_ape, tra_nom, tra_fei, tra_fna, tra_sex, tra_dir, tra_cor, tra_tel,
              tra_cta, tra_pro, tra_det, tra_fco, tra_egr, tra_hij, tra_adm, tra_tit, tra_esp
         FROM noda1100 WHERE tra_ced = ? LIMIT 1`,
      [cedula],
    );
    const [cargos] = await pool.query(
      `SELECT c.rac_cod, c.rac_nro, c.nom_cod, c.car_sue, c.ubi_cod, c.car_cod, c.tab_cod,
              c.tab_niv, c.tab_hor, c.car_sus, c.car_com, c.com_ubi,
              (SELECT n.nom_nom FROM noda1400 n WHERE n.nom_cod = c.nom_cod LIMIT 1) AS nom_nom,
              (SELECT u.ubi_nom FROM noda1800 u WHERE u.ubi_cod = c.ubi_cod LIMIT 1) AS ubi_nom,
              (SELECT k.car_nom FROM noda1300 k WHERE k.car_cod = c.car_cod LIMIT 1) AS car_nom,
              (SELECT u.ubi_nom FROM noda1800 u WHERE u.ubi_cod = c.com_ubi LIMIT 1) AS com_ubi_nom
         FROM noda1200 c WHERE c.tra_ced = ? ORDER BY c.rac_cod`,
      [cedula],
    );
    // Preliminar de la nómina: solo si tiene cargo. nocod = 2 primeros dígitos del código de nómina del cargo.
    // Un pago (noda1600) aplica si alguna asignación del trabajador (noda2100) está asociada a ese pago en noda1601.
    // Neto = asignaciones - deducciones, con los mismos filtros del detalle (montos > 0 y deducciones de la misma nómina).
    // Pagos quincenales (pag_cod empieza por "Q"): cada monto se divide entre 2.
    let preliminar = [];
    const nocods = [...new Set(cargos.map((c) => String(c.nom_cod || '').trim().slice(0, 2)).filter(Boolean))];
    if (nocods.length > 0) {
      const [rows] = await pool.query(
        `SELECT p.nom_cod, p.pag_nro, p.pag_cod, p.pag_des, p.pag_has, p.pag_nom, p.pag_dia,
                a.asi_mon - COALESCE(b.ded_mon, 0) AS neto
           FROM noda1600 p
           JOIN (SELECT x.nom_cod, d.pag_nro,
                        SUM(CASE WHEN d.asi_mon > 0 THEN ROUND(d.asi_mon / ${DIVISOR_SQL}, 2) ELSE 0 END) AS asi_mon
                   FROM noda2100 d
                   JOIN (SELECT DISTINCT nom_cod, pag_nro, asi_nro FROM noda1601 WHERE nom_cod IN (?)) x
                     ON x.pag_nro = d.pag_nro AND x.asi_nro = d.asi_nro
                   JOIN noda1900 ad ON ad.asi_nro = d.asi_nro -- se omiten asignaciones inexistentes en noda1900
                   JOIN noda1600 pp ON pp.nom_cod = x.nom_cod AND pp.pag_nro = d.pag_nro
                  WHERE d.tra_ced = ?
                  GROUP BY x.nom_cod, d.pag_nro) a ON a.nom_cod = p.nom_cod AND a.pag_nro = p.pag_nro
           LEFT JOIN (SELECT x.nom_cod, d.pag_nro, SUM(ROUND(d.ded_mon / ${DIVISOR_SQL}, 2)) AS ded_mon
                   FROM noda2200 d
                   JOIN noda2000 e ON e.ded_nro = d.ded_nro
                   JOIN (SELECT DISTINCT nom_cod, pag_nro, asi_nro FROM noda1601 WHERE nom_cod IN (?)) x
                     ON x.pag_nro = d.pag_nro AND x.asi_nro = e.asi_nro
                   JOIN noda1600 pp ON pp.nom_cod = x.nom_cod AND pp.pag_nro = d.pag_nro
                  WHERE d.tra_ced = ? AND d.ded_mon > 0
                  GROUP BY x.nom_cod, d.pag_nro) b ON b.nom_cod = p.nom_cod AND b.pag_nro = p.pag_nro
          ORDER BY p.pag_nro, p.nom_cod`,
        [nocods, cedula, nocods, cedula],
      );
      preliminar = rows.map(trimRow);
    }
    res.json({
      cedula,
      personal: personal[0] ? trimRow(personal[0]) : null,
      cargos: cargos.map(trimRow),
      preliminar,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Error consultando la base de datos' });
  }
});

// Detalle de un pago del preliminar: asignaciones (noda2100) y deducciones (noda2200) del trabajador
app.get('/api/trabajador/preliminar/detalle', accesoConsulta, async (req, res) => {
  const ced = String(req.query.ced || '').toUpperCase();
  const nom = String(req.query.nom || '');
  const pag = String(req.query.pag || '');
  if (!/^[VEP]\d{11}$/.test(ced) || !/^\w{1,2}$/.test(nom) || !/^\w{1,3}$/.test(pag)) {
    return res.status(400).json({ message: 'Parámetros inválidos' });
  }
  try {
    // Pagos quincenales (pag_cod empieza por "Q"): cada monto se divide entre 2, igual que en el neto de la línea
    const [pagos] = await pool.query(
      `SELECT ${DIVISOR_SQL} AS divisor FROM noda1600 pp WHERE pp.nom_cod = ? AND pp.pag_nro = ? LIMIT 1`,
      [nom, pag],
    );
    const divisor = Number(pagos[0]?.divisor || 1);
    const [asignaciones] = await pool.query(
      `SELECT d.asi_nro, a.ing_cod, a.asi_cod, i.ing_nom, a.asi_nom, a.asi_sus, SUM(ROUND(d.asi_mon / ?, 2)) AS asi_mon
         FROM noda2100 d
         JOIN (SELECT DISTINCT nom_cod, pag_nro, asi_nro FROM noda1601 WHERE nom_cod = ? AND pag_nro = ?) x
           ON x.pag_nro = d.pag_nro AND x.asi_nro = d.asi_nro
         JOIN noda1900 a ON a.asi_nro = d.asi_nro -- se omiten asignaciones inexistentes en noda1900
         LEFT JOIN noda1910 i ON i.ing_cod = a.ing_cod
        WHERE d.tra_ced = ? AND d.pag_nro = ? AND d.asi_mon > 0
        GROUP BY d.asi_nro, a.ing_cod, a.asi_cod, i.ing_nom, a.asi_nom, a.asi_sus
        ORDER BY d.asi_nro`,
      [divisor, nom, pag, ced, pag],
    );
    const [deducciones] = await pool.query(
      `SELECT d.ded_nro, e.egr_cod, g.egr_nom, t.egr_rif AS ent_rif, t.egr_nom AS ent_nom, e.ded_nom, SUM(ROUND(d.ded_mon / ?, 2)) AS ded_mon
         FROM noda2200 d
         JOIN noda2000 e ON e.ded_nro = d.ded_nro -- se omiten deducciones inexistentes en noda2000
         -- Solo deducciones de la nómina del pago: descarta restos de nóminas anteriores del trabajador
         JOIN (SELECT DISTINCT asi_nro FROM noda1601 WHERE nom_cod = ? AND pag_nro = ?) x ON x.asi_nro = e.asi_nro
         LEFT JOIN noda2010 g ON g.egr_cod = e.egr_cod
         LEFT JOIN nominatablaegreso t ON t.egr_rif = e.ded_cod
        WHERE d.tra_ced = ? AND d.pag_nro = ? AND d.ded_mon > 0
        GROUP BY d.ded_nro, e.egr_cod, g.egr_nom, t.egr_rif, t.egr_nom, e.ded_nom
        ORDER BY d.ded_nro`,
      [divisor, nom, pag, ced, pag],
    );
    res.json({ asignaciones: asignaciones.map(trimRow), deducciones: deducciones.map(trimRow) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Error consultando el detalle del pago' });
  }
});

// Historial de pagos por año: recorre las bases <DB_PREFIX><año> desde el año actual hasta HIST_DESDE
const DB_PREFIX = process.env.DB_PREFIX || 'o0002a';
const HIST_DESDE = Number(process.env.HIST_DESDE || 2003);

async function basesConHistorial() {
  const anios = [];
  for (let a = new Date().getFullYear(); a >= HIST_DESDE; a--) anios.push(a);
  const nombres = anios.map((a) => `${DB_PREFIX}${a}`);
  const [rows] = await pool.query(
    `SELECT TABLE_SCHEMA AS db, GROUP_CONCAT(TABLE_NAME) AS tablas FROM information_schema.TABLES
      WHERE TABLE_SCHEMA IN (?)
        AND TABLE_NAME IN ('noda2500', 'noda2600', 'noda1400', 'noda2700', 'noda2800', 'noda3000')
      GROUP BY TABLE_SCHEMA`,
    [nombres],
  );
  const porDb = new Map(rows.map((r) => [r.db, String(r.tablas).split(',')]));
  return anios
    .map((anio) => ({ anio, db: `${DB_PREFIX}${anio}`, tablas: porDb.get(`${DB_PREFIX}${anio}`) || [] }))
    .filter((b) => b.tablas.includes('noda2500') && b.tablas.includes('noda2600'));
}

app.get('/api/trabajador/historial', accesoConsulta, async (req, res) => {
  const ced = String(req.query.ced || '').toUpperCase();
  if (!/^[VEP]\d{11}$/.test(ced)) return res.status(400).json({ message: 'Cédula inválida' });
  try {
    const bases = await basesConHistorial();
    const resultados = await Promise.all(
      bases.map(async ({ anio, db, tablas }) => {
        const nomina = tablas.includes('noda1400')
          ? `(SELECT n.nom_nom FROM \`${db}\`.noda1400 n WHERE n.nom_cod = p.nom_cod LIMIT 1)`
          : 'NULL';
        try {
          const [pagos] = await pool.query(
            `SELECT p.act_nro, p.pag_nro, p.pag_cod, p.pag_des, p.pag_has, p.pag_nom, p.nom_cod,
                    ${nomina} AS nom_nom, SUM(t.tra_net) AS tra_net
               FROM \`${db}\`.noda2600 t JOIN \`${db}\`.noda2500 p ON p.act_nro = t.act_nro
              WHERE t.tra_ced = ?
              GROUP BY p.act_nro, p.pag_nro, p.pag_cod, p.pag_des, p.pag_has, p.pag_nom, p.nom_cod
              ORDER BY p.act_nro DESC`,
            [ced],
          );
          return { anio, pagos: pagos.map(trimRow) };
        } catch (err) {
          console.error(`Historial ${db}:`, err.message);
          return { anio, pagos: [] };
        }
      }),
    );
    res.json(resultados.filter((r) => r.pagos.length > 0));
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Error consultando el historial' });
  }
});

// Detalle de una actualización del historial: asignaciones (noda2700) y deducciones (noda2800) del trabajador,
// con su descripción en noda3000. Los movimientos que no estén en noda3000 se omiten.
app.get('/api/trabajador/historial/detalle', accesoConsulta, async (req, res) => {
  const ced = String(req.query.ced || '').toUpperCase();
  const anio = Number(req.query.anio);
  const act = Number(req.query.act);
  if (!/^[VEP]\d{11}$/.test(ced) || !Number.isInteger(anio) || !Number.isInteger(act)) {
    return res.status(400).json({ message: 'Parámetros inválidos' });
  }
  try {
    const base = (await basesConHistorial()).find((b) => b.anio === anio);
    const tablas = base?.tablas || [];
    if (!base || !tablas.includes('noda3000')) return res.json({ asignaciones: [], deducciones: [] });
    const db = `\`${base.db}\``;
    const [asignaciones] = tablas.includes('noda2700')
      ? await pool.query(
          `SELECT d.asi_nro, m.mov_nom, SUM(d.asi_mon) AS asi_mon
             FROM ${db}.noda2700 d
             JOIN ${db}.noda3000 m ON m.act_nro = d.act_nro AND m.mov_tip = 'A' AND m.mov_nro = d.asi_nro
            WHERE d.tra_ced = ? AND d.act_nro = ?
            GROUP BY d.asi_nro, m.mov_nom
            ORDER BY d.asi_nro`,
          [ced, act],
        )
      : [[]];
    const [deducciones] = tablas.includes('noda2800')
      ? await pool.query(
          `SELECT d.ded_nro, m.mov_nom, m.ded_cod, SUM(d.ded_mon) AS ded_mon
             FROM ${db}.noda2800 d
             JOIN ${db}.noda3000 m ON m.act_nro = d.act_nro AND m.mov_tip = 'D' AND m.mov_nro = d.ded_nro
            WHERE d.tra_ced = ? AND d.act_nro = ?
            GROUP BY d.ded_nro, m.mov_nom, m.ded_cod
            ORDER BY d.ded_nro`,
          [ced, act],
        )
      : [[]];
    res.json({ asignaciones: asignaciones.map(trimRow), deducciones: deducciones.map(trimRow) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Error consultando el detalle de la actualización' });
  }
});

// Reporte "Otros Conceptos Gastos de Personal" del mes indicado, sobre el año de la base activa (DB_NAME)
app.get('/api/reportes/otros-conceptos', requireAuth, requirePermiso(PANTALLA_REPORTES), async (req, res) => {
  const mes = Number(req.query.mes);
  if (!Number.isInteger(mes) || mes < 1 || mes > 12) return res.status(400).json({ message: 'Mes inválido' });
  const anio = Number(String(process.env.DB_NAME).slice(-4));
  try {
    const { nombreArchivo, buffer } = await generarOtrosConceptos(anio, mes);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(nombreArchivo)}`);
    res.send(Buffer.from(buffer));
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Error generando el reporte' });
  }
});

// Master RRHH: Ficha Personal
const accesoRrhh = [requireAuth, requirePermiso(PANTALLA_RRHH)];
const archivoExcel = express.raw({ type: 'application/octet-stream', limit: '10mb' });

app.get('/api/rrhh/ficha/modelo', accesoRrhh, async (req, res) => {
  try {
    const buffer = await generarModelo();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent('FICHA PERSONAL - MODELO.xlsx')}`);
    res.send(Buffer.from(buffer));
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Error generando el modelo' });
  }
});

// Paso 1: lee el archivo y devuelve lo que se cambiaría, sin modificar nada
app.post('/api/rrhh/ficha/analizar', accesoRrhh, archivoExcel, async (req, res) => {
  if (!req.body?.length) return res.status(400).json({ message: 'No se recibió ningún archivo' });
  try {
    res.json(await analizarArchivo(req.body));
  } catch (err) {
    console.error(err);
    res.status(400).json({ message: err.message || 'No se pudo leer el archivo' });
  }
});

// Paso 2: vuelve a analizar el mismo archivo contra los datos actuales, aplica los cambios y los audita
app.post('/api/rrhh/ficha/aplicar', accesoRrhh, archivoExcel, async (req, res) => {
  if (!req.body?.length) return res.status(400).json({ message: 'No se recibió ningún archivo' });
  try {
    const filas = await analizarArchivo(req.body);
    const equipo = await nombreEquipo(req);
    res.json(await aplicarCambios(filas, { usuario: req.user.cedula, equipo }));
  } catch (err) {
    console.error(err);
    res.status(400).json({ message: err.message || 'No se pudieron aplicar los cambios' });
  }
});

app.use('/api', (req, res) => res.status(404).json({ message: 'Ruta no encontrada' }));

const port = Number(process.env.PORT || 3001);
const host = process.env.HOST || '0.0.0.0';
app.listen(port, host, () => {
  console.log(`API INSAWEB escuchando en http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`);
  if (origenesCors.length) console.log(`CORS habilitado para: ${origenesCors.join(', ')}`);
  verificarIndices(); // en segundo plano: crea los índices que falten sin detener el servidor
});
