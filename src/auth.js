import jwt from 'jsonwebtoken';
import { pool } from './db.js';

// Formulario (pantalla) de consulta de nómina en usuariofor.for_nom
export const PANTALLA_CONSULTA = 'CNFO1203';
// Formulario del módulo de reportes
export const PANTALLA_REPORTES = 'COM_FOR';
// Formulario del módulo Master RRHH
export const PANTALLA_RRHH = 'FONO2301';

export async function pantallasDeUsuario(cedula) {
  const [rows] = await pool.query('SELECT DISTINCT TRIM(for_nom) AS for_nom FROM usuariofor WHERE usu_ced = ?', [
    Number(cedula),
  ]);
  return rows.map((r) => r.for_nom);
}

export async function tienePermiso(cedula, pantalla) {
  const [rows] = await pool.query('SELECT 1 FROM usuariofor WHERE usu_ced = ? AND TRIM(for_nom) = ? LIMIT 1', [
    Number(cedula),
    pantalla,
  ]);
  return rows.length > 0;
}

// Se verifica en cada petición, para que un permiso retirado se aplique de inmediato
export function requirePermiso(pantalla) {
  return async (req, res, next) => {
    try {
      if (await tienePermiso(req.user.cedula, pantalla)) return next();
      res.status(403).json({ message: 'No tiene acceso a esta pantalla' });
    } catch (err) {
      console.error(err);
      res.status(500).json({ message: 'Error verificando permisos' });
    }
  };
}

export function signToken(payload) {
  return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES || '8h' });
}

export function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ message: 'No autenticado' });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ message: 'Sesión expirada o inválida' });
  }
}
