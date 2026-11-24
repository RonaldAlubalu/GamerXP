-- A new preparation task, also for the parties that are still to come.
INSERT INTO booking_tasks (booking_id, stage, label, sort_order)
SELECT b.id, 'scheduled', 'Dag vooraf: consoles en games gecontroleerd op updates',
       coalesce((SELECT max(t.sort_order) FROM booking_tasks t WHERE t.booking_id = b.id AND t.stage = 'scheduled'), 0) + 1
  FROM bookings b
 WHERE b.status IN ('new', 'contacted', 'confirmed', 'deposit_paid', 'scheduled')
   AND NOT EXISTS (SELECT 1 FROM booking_tasks t WHERE t.booking_id = b.id AND t.label = 'Dag vooraf: consoles en games gecontroleerd op updates');
