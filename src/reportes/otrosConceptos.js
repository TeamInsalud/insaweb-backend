import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';
import { pool } from '../db.js';

const PLANTILLA = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../plantillas/otros_conceptos_gastos_personal.xlsx',
);

export const MESES = [
  'ENERO', 'FEBRERO', 'MARZO', 'ABRIL', 'MAYO', 'JUNIO',
  'JULIO', 'AGOSTO', 'SEPTIEMBRE', 'OCTUBRE', 'NOVIEMBRE', 'DICIEMBRE',
];

const TIPOS = ['EF', 'OF', 'EC', 'OC'];
const COLUMNA_TIPO = { EF: 'F', OF: 'G', EC: 'H', OC: 'I' };

// Tipo de nómina según los 2 primeros dígitos de nom_cod (noda2500); las demás nóminas quedan como 'OTRA'
const TIPO_SQL = `CASE
  WHEN LEFT(p.nom_cod, 2) IN ('01', '13', '98') THEN 'EF'
  WHEN LEFT(p.nom_cod, 2) = '02' THEN 'OF'
  WHEN LEFT(p.nom_cod, 2) IN ('03', '07') THEN 'EC'
  WHEN LEFT(p.nom_cod, 2) = '04' THEN 'OC'
  ELSE 'OTRA' END`;

// Filas de la hoja MPPS: código de egreso, tipos de nómina que suma, fila del detalle y fila que la copia
const FILAS_MPPS = [
  { egr: '442', fila: 28, copia: 20 },
  { egr: '271', fila: 26, copia: 18 },
  { egr: '281', fila: 27, copia: 19 },
  { egr: '004', tipos: ['EC', 'OC'], fila: 22, copia: 14 },
  { egr: '004', tipos: ['EF'], fila: 23, copia: 15 },
  { egr: '004', tipos: ['OF'], fila: 24, copia: 16 },
  { egr: '043', fila: 30 },
  { egr: '444', fila: 31 },
  { egr: '040', fila: 32 },
];

const CODIGOS = [...new Set([...FILAS_MPPS.map((f) => f.egr), '001', '002', '003', '005'])];

const redondear = (n) => Math.round(n * 100) / 100;

// Deducciones del mes (noda2800 de las actualizaciones de noda2500 cuyo pag_des cae en el mes), por egr_cod y tipo
async function deduccionesDelMes(anio, mes) {
  const [rows] = await pool.query(
    `SELECT e.egr_cod, ${TIPO_SQL} AS tipo, SUM(d.ded_mon) AS monto, COUNT(DISTINCT d.tra_ced) AS trabajadores
       FROM noda2500 p
       JOIN noda2800 d ON d.act_nro = p.act_nro
       JOIN noda2000 e ON e.ded_nro = d.ded_nro
      WHERE p.pag_des LIKE ? AND e.egr_cod IN (?)
      GROUP BY e.egr_cod, tipo`,
    [`${anio}${String(mes).padStart(2, '0')}%`, CODIGOS],
  );
  const datos = {};
  for (const r of rows) {
    datos[r.egr_cod] ??= {};
    datos[r.egr_cod][r.tipo] = { monto: Number(r.monto), trabajadores: Number(r.trabajadores) };
  }
  return datos;
}

// Monto y trabajadores de un código; "tipos" limita a esos tipos de nómina (sin límite = todas las nóminas)
function resumen(datos, egr, tipos) {
  const porTipo = datos[egr] || {};
  const incluidos = tipos ?? Object.keys(porTipo);
  const monto = redondear(incluidos.reduce((s, t) => s + (porTipo[t]?.monto || 0), 0));
  const trabajadores = Object.fromEntries(
    TIPOS.map((t) => [t, incluidos.includes(t) ? porTipo[t]?.trabajadores || 0 : 0]),
  );
  return { monto, trabajadores };
}

export async function generarOtrosConceptos(anio, mes) {
  const nombreMes = MESES[mes - 1];
  const datos = await deduccionesDelMes(anio, mes);

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(PLANTILLA);
  const mpps = wb.getWorksheet('MPPS');
  const pdts = wb.getWorksheet('CONCEPTOS PDTS');

  // Hoja MPPS
  const montoFila = {};
  for (const f of FILAS_MPPS) {
    const { monto, trabajadores } = resumen(datos, f.egr, f.tipos);
    for (const fila of [f.fila, f.copia].filter(Boolean)) {
      mpps.getCell(`E${fila}`).value = monto;
      for (const t of TIPOS) mpps.getCell(`${COLUMNA_TIPO[t]}${fila}`).value = trabajadores[t];
      montoFila[fila] = monto;
    }
  }
  const suma = (...filas) => redondear(filas.reduce((s, f) => s + (montoFila[f] || 0), 0));
  const e13 = suma(14, 15, 16);
  const e17 = suma(18, 19, 20);
  const e21 = suma(22, 23, 24);
  const e25 = suma(26, 27, 28);
  const e29 = suma(30, 31, 32, 33);

  // Hoja CONCEPTOS PDTS
  const total = (egr) => resumen(datos, egr).monto;
  pdts.getCell('A5').value = `MES DE ${nombreMes} ${anio}`;
  pdts.getCell('B9').value = nombreMes;
  pdts.getCell('B14').value = e13;
  pdts.getCell('B15').value = e17;
  pdts.getCell('B20').value = redondear(e21 + e25 + e29);
  pdts.getCell('B16').value = total('001');
  pdts.getCell('B10').value = redondear(total('001') * 2.25);
  pdts.getCell('B17').value = total('002');
  pdts.getCell('B11').value = redondear(total('002') * 4);
  pdts.getCell('B18').value = total('003');
  pdts.getCell('B12').value = redondear(total('003') * 2);
  pdts.getCell('B19').value = total('005');

  // Las fórmulas de la plantilla (subtotales y totales) se recalculan al abrir el archivo
  wb.calcProperties = { ...wb.calcProperties, fullCalcOnLoad: true };

  // La plantilla trae nombres definidos sobrantes (un filtro sin uso y referencias a libros externos) que exceljs
  // no puede reescribir bien y hacen que Excel pida reparar el archivo. Ninguno se usa en el reporte; las áreas de
  // impresión no se pierden porque exceljs las guarda en la configuración de página de cada hoja.
  wb.definedNames.model = [];
  // exceljs escribe el área de impresión con la fila relativa ($A1:$C23) y Excel la desplaza; se fija la fila
  // (A$1:C$23) para que quede absoluta ($A$1:$C$23), porque exceljs ya antepone el $ a la columna.
  wb.eachSheet((ws) => {
    if (!ws.pageSetup.printArea) return;
    ws.pageSetup.printArea = ws.pageSetup.printArea
      .split(':')
      .map((ref) => ref.replace(/^\$?([A-Z]+)\$?(\d+)$/, '$1$$$2'))
      .join(':');
  });

  return {
    nombreArchivo: `OTROS CONCEPTOS GASTOS DE PERSONAL ${nombreMes} ${anio}.xlsx`,
    buffer: await wb.xlsx.writeBuffer(),
  };
}
