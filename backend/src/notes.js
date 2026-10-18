const express = require('express');
const { validateNote } = require('./validate');
const { wrap } = require('./auth');

const publicNote = (n) => ({
  id: n.id,
  title: n.title,
  body: n.body,
  createdAt: n.created_at,
  updatedAt: n.updated_at,
});

// All queries are scoped to req.user, so one user can never read or change another's notes
function notesRouter(pool) {
  const router = express.Router();

  router.param('id', (req, res, next, id) => {
    if (!/^\d+$/.test(id) || Number(id) > 2147483647) {
      return res.status(400).json({ error: 'id must be a positive integer' });
    }
    next();
  });

  router.get('/', wrap(async (req, res) => {
    const { rows } = await pool.query(
      'SELECT * FROM notes WHERE user_id = $1 ORDER BY created_at DESC, id DESC',
      [req.user.id]
    );
    res.json(rows.map(publicNote));
  }));

  router.post('/', wrap(async (req, res) => {
    const errors = validateNote(req.body);
    if (errors.length) return res.status(400).json({ error: 'Validation failed', details: errors });
    const { rows } = await pool.query(
      'INSERT INTO notes (user_id, title, body) VALUES ($1, $2, $3) RETURNING *',
      [req.user.id, req.body.title.trim(), req.body.body ?? '']
    );
    res.status(201).json(publicNote(rows[0]));
  }));

  router.patch('/:id', wrap(async (req, res) => {
    const errors = validateNote(req.body, { partial: true });
    if (errors.length) return res.status(400).json({ error: 'Validation failed', details: errors });
    const { rows } = await pool.query(
      `UPDATE notes SET title = COALESCE($3, title), body = COALESCE($4, body), updated_at = now()
       WHERE id = $1 AND user_id = $2 RETURNING *`,
      [req.params.id, req.user.id, req.body.title?.trim() ?? null, req.body.body ?? null]
    );
    if (!rows.length) return res.status(404).json({ error: 'Note not found' });
    res.json(publicNote(rows[0]));
  }));

  router.delete('/:id', wrap(async (req, res) => {
    const { rowCount } = await pool.query(
      'DELETE FROM notes WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user.id]
    );
    if (!rowCount) return res.status(404).json({ error: 'Note not found' });
    res.status(204).end();
  }));

  return router;
}

module.exports = { notesRouter };
