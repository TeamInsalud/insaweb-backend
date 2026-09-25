import os from 'node:os';
import dns from 'node:dns/promises';
import ExcelJS from 'exceljs';
import { pool } from '../db.js';

// Columnas del modelo de Ficha Personal. Desde la C, cada una reemplaza un campo de noda1100 si la celda tiene valor.
const COLUMNAS = [
  { col: 'A', titulo: 'Nacionalidad', ancho: 14 },
  { col: 'B', titulo: 'Nro Cedula', ancho: 14 },
  { col: 'C', titulo: 'Apellidos', campo: 'tra_ape', max: 100, ancho: 28 },
  { col: 'D', titulo: 'Nombres', campo: 'tra_nom', max: 100, ancho: 28 },
  { col: 'E', titulo: 'Genero', campo: 'tra_sex', max: 1, ancho: 10 },
  { col: 'F', titulo: 'Correo', campo: 'tra_cor', max: 150, ancho: 32 },
  { col: 'G', titulo: 'Telefono', campo: 'tra_tel', max: 50, ancho: 16 },
  { col: 'H', titulo: 'Direccion', campo: 'tra_dir', max: 150, ancho: 45 },
  { col: 'I', titulo: 'Titulo', campo: 'tra_tit', max: 150, ancho: 30 },
  { col: 'J', titulo: 'Especialidad', campo: 'tra_esp', max: 150, ancho: 30 },
];
const CAMPOS = COLUMNAS.filter((c) => c.campo);

export async function generarModelo() {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Ficha Personal', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = COLUMNAS.map((c) => ({ header: c.titulo, key: c.col, width: c.ancho }));
  ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF075985' } };
  ws.getColumn('B').numFmt = '@';
  ws.getColumn('G').numFmt = '@'; // texto: conserva el 0 inicial de los teléfonos
  for (let fila = 2; fila <= 1000; fila++) {
    ws.getCell(`A${fila}`).dataValidation = { type: 'list', allowBlank: true, formulae: ['"V,E,P"'] };
    ws.getCell(`E${fila}`).dataValidation = { type: 'list', allowBlank: true, formulae: ['"F,M"'] };
  }
  return wb.xlsx.writeBuffer();
}

// Texto visible de una celda (maneja números, hipervínculos de correo, texto enriquecido, etc.)
function textoCelda(ws, ref) {
  const cell = ws.getCell(ref);
  if (cell.value === null || cell.value === undefined) return '';
  return String(cell.text ?? '').replace(/\s+/g, ' ').trim();
}

const limpiar = (v) => String(v ?? '').trim();

// Lee el archivo y compara cada fila con noda1100. No modifica nada.
export async function analizarArchivo(buffer) {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buffer);
  } catch {
    throw new Error('El archivo no es un Excel (.xlsx) válido');
  }
  const ws = wb.worksheets[0];
  if (!ws) throw new Error('El archivo no tiene hojas');

  const filas = [];
  const vistas = new Map();
  for (let n = 2; n <= ws.rowCount; n++) {
    const valores = Object.fromEntries(COLUMNAS.map((c) => [c.col, textoCelda(ws, `${c.col}${n}`)]));
    // Un teléfono escrito como número en Excel pierde el 0 inicial (4141234567 → 04141234567)
    if (typeof ws.getCell(`G${n}`).value === 'number' && /^\d{10}$/.test(valores.G)) valores.G = `0${valores.G}`;
    if (COLUMNAS.every((c) => valores[c.col] === '')) continue; // fila vacía

    const fila = { fila: n, cedula: null, nombre: null, estado: 'error', cambios: [], avisos: [] };
    filas.push(fila);
    const nac = valores.A.toUpperCase();
    const numero = valores.B.replace(/\D/g, '');
    if (!['V', 'E', 'P'].includes(nac)) {
      fila.mensaje = `Nacionalidad "${valores.A}" inválida (debe ser V, E o P)`;
      continue;
    }
    if (!numero || numero.length > 8) {
      fila.mensaje = `Número de cédula "${valores.B}" inválido`;
      continue;
    }
    fila.cedula = `${nac}${numero.padStart(8, '0')}000`;
    if (vistas.has(fila.cedula)) {
      fila.mensaje = `Cédula repetida (ya aparece en la fila ${vistas.get(fila.cedula)})`;
      continue;
    }
    vistas.set(fila.cedula, n);

    const [rows] = await pool.query(
      `SELECT tra_nom, tra_ape, ${CAMPOS.map((c) => c.campo).join(', ')} FROM noda1100 WHERE tra_ced = ? LIMIT 1`,
      [fila.cedula],
    );
    const actual = rows[0];
    if (!actual) {
      fila.estado = 'no_encontrado';
      fila.mensaje = 'No existe en noda1100';
      continue;
    }
    fila.nombre = `${limpiar(actual.tra_nom)} ${limpiar(actual.tra_ape)}`.trim();

    for (const c of CAMPOS) {
      if (valores[c.col] === '') continue; // celda vacía: no se toca el campo
      const nuevo = valores[c.col].toLocaleUpperCase('es-VE'); // se graba en mayúsculas, como el resto de la base
      if (c.campo === 'tra_sex') {
        if (!['F', 'M'].includes(nuevo)) {
          fila.avisos.push(`Género "${valores[c.col]}" ignorado (debe ser F o M)`);
          continue;
        }
      }
      if (nuevo.length > c.max) {
        fila.avisos.push(`${c.titulo} ignorado: tiene ${nuevo.length} caracteres (máximo ${c.max})`);
        continue;
      }
      const anterior = limpiar(actual[c.campo]);
      if (anterior !== nuevo) fila.cambios.push({ campo: c.campo, titulo: c.titulo, anterior, nuevo });
    }
    fila.estado = fila.cambios.length > 0 ? 'con_cambios' : 'sin_cambios';
  }
  return filas;
}

// Nombre del equipo desde donde se hace el cambio (DNS inverso de su IP; si no se resuelve, la IP)
export async function nombreEquipo(req) {
  // req.ip solo considera X-Forwarded-For si TRUST_PROXY está configurado, así no se puede falsificar el equipo
  const ip = String(req.ip || req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  if (!ip || ip === '127.0.0.1' || ip === '::1') return os.hostname();
  try {
    const [nombre] = await Promise.race([
      dns.reverse(ip),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 1500)),
    ]);
    return nombre ? nombre.split('.')[0].toUpperCase() : ip;
  } catch {
    return ip;
  }
}

// Fecha con el mismo formato que usa el sistema en la tabla auditoria: 31/07/2026 12:43:01 AM
function fechaAuditoria(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  const h = d.getHours() % 12 || 12;
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(h)}:${p(d.getMinutes())}:${p(
    d.getSeconds(),
  )} ${d.getHours() < 12 ? 'AM' : 'PM'}`;
}

// Aplica los cambios: un UPDATE por trabajador, y en auditoria el SQL exacto que se ejecutó
export async function aplicarCambios(filas, { usuario, equipo }) {
  for (const fila of filas) {
    if (fila.estado !== 'con_cambios') continue;
    const sets = fila.cambios.map((c) => `${c.campo} = ?`).join(', ');
    const sql = pool.format(`UPDATE noda1100 SET ${sets} WHERE tra_ced = ?`, [
      ...fila.cambios.map((c) => c.nuevo),
      fila.cedula,
    ]);
    try {
      await pool.query(sql);
    } catch (err) {
      fila.estado = 'error';
      fila.mensaje = `No se pudo actualizar: ${err.message}`;
      continue;
    }
    fila.estado = 'actualizado';
    try {
      await pool.query('INSERT INTO auditoria (fecha, equipo, usuario, detalle) VALUES (?, ?, ?, ?)', [
        fechaAuditoria(),
        `${equipo} # INSAWEB`.slice(0, 50),
        String(usuario).slice(0, 10),
        sql,
      ]);
    } catch (err) {
      console.error('Auditoría no registrada:', err.message, sql);
      fila.avisos.push('Actualizado, pero no se pudo registrar la auditoría');
    }
  }
  return filas;
}
