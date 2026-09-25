import { pool } from './db.js';

// Índices que el sistema necesita para rendir bien. Se revisan al arrancar el servidor y se crean si faltan.
const INDICES = [
  {
    tabla: 'noda2800',
    nombre: 'idx_noda2800_act',
    columnas: ['act_nro', 'ded_nro'], // reporte Otros Conceptos: deducciones por actualización
  },
];

// ¿Existe ya algún índice de la tabla que empiece por las mismas columnas? (sin importar su nombre)
async function tieneIndice(db, tabla, columnas) {
  const [rows] = await pool.query(
    `SELECT INDEX_NAME, GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) AS cols
       FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
      GROUP BY INDEX_NAME`,
    [db, tabla],
  );
  const buscado = columnas.join(',').toLowerCase();
  return rows.some((r) => `${String(r.cols).toLowerCase()},`.startsWith(`${buscado},`));
}

async function existeTabla(db, tabla) {
  const [rows] = await pool.query(
    'SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? LIMIT 1',
    [db, tabla],
  );
  return rows.length > 0;
}

export async function verificarIndices() {
  const db = process.env.DB_NAME;
  for (const { tabla, nombre, columnas } of INDICES) {
    try {
      if (!(await existeTabla(db, tabla))) continue;
      if (await tieneIndice(db, tabla, columnas)) {
        console.log(`[índices] ${db}.${tabla}: índice (${columnas.join(', ')}) presente`);
        continue;
      }
      console.log(`[índices] ${db}.${tabla}: creando índice ${nombre} (${columnas.join(', ')})…`);
      const inicio = Date.now();
      await pool.query(`CREATE INDEX \`${nombre}\` ON \`${db}\`.\`${tabla}\` (${columnas.map((c) => `\`${c}\``).join(', ')})`);
      console.log(`[índices] ${db}.${tabla}: índice ${nombre} creado en ${((Date.now() - inicio) / 1000).toFixed(1)} s`);
    } catch (err) {
      console.error(`[índices] ${db}.${tabla}: no se pudo verificar/crear el índice:`, err.message);
    }
  }
}
