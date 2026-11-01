import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';

const tempDirectory = await mkdtemp(join(tmpdir(), 'escape-villa-cancellation-'));
const databasePath = join(tempDirectory, 'test.sqlite3');
const setupKey = 'integration-setup-key-that-is-long-enough-2026';
const port = await new Promise((resolve, reject) => {
  const probe = createServer();
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => {
    const selectedPort = probe.address().port;
    probe.close((error) => error ? reject(error) : resolve(selectedPort));
  });
});
const base = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['dist/server.js'], {
  cwd: process.cwd(),
  env: { ...process.env, PORT: String(port), DATABASE_PATH: databasePath, ESCAPE_VILLA_SETUP_KEY: setupKey, ESCAPE_VILLA_SECRET: 'isolated-test-session-secret' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverOutput = '';
server.stdout.setEncoding('utf8').on('data', (chunk) => { serverOutput += chunk; });
server.stderr.setEncoding('utf8').on('data', (chunk) => { serverOutput += chunk; });

async function call(path, { method = 'GET', body, cookie } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setCookie = response.headers.get('set-cookie')?.split(';')[0];
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: response.status, data, cookie: setCookie };
}

async function waitForServer() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (server.exitCode !== null) throw new Error(`Server exited early.\n${serverOutput}`);
    try {
      const response = await fetch(`${base}/api/public`);
      if (response.ok) return;
    } catch { /* Wait until the local server has bound its port. */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Server did not become ready.\n${serverOutput}`);
}

async function expectStatus(result, expected, label) {
  assert.equal(result.status, expected, `${label}: expected HTTP ${expected}, got ${result.status}; response=${JSON.stringify(result.data)}`);
}

async function run() {
  await waitForServer();
  let response = await call('/api/admin/setup', { method: 'POST', body: { setup_key: setupKey, name: 'Test Admin', email: 'admin@test.invalid', password: 'AdminPassword!234' } });
  await expectStatus(response, 200, 'create administrator');
  const adminCookie = response.cookie;
  assert.ok(adminCookie, 'administrator session cookie is set');
  response = await call('/api/admin/cancellation-policy', { method: 'PATCH', cookie: adminCookie, body: { fullRefundDays: 10, partialRefundDays: 5, partialRefundPercent: 40 } });
  await expectStatus(response, 200, 'admin edits cancellation policy');
  response = await call('/api/admin/cancellation-policy', { method: 'PATCH', cookie: adminCookie, body: { fullRefundDays: 7, partialRefundDays: 3, partialRefundPercent: 50 } });
  await expectStatus(response, 200, 'admin restores requested policy thresholds');

  response = await call('/api/public');
  await expectStatus(response, 200, 'load services');
  const photography = response.data.services.find((service) => service.name === 'Photography');
  const photographyPackage = response.data.packages.find((item) => item.service_id === photography.id);
  assert.ok(photographyPackage, 'Photography package exists');

  response = await call('/api/admin/staff', { method: 'POST', cookie: adminCookie, body: { name: 'Photo Staff', email: 'staff@test.invalid', phone: '0710000000', password: 'StaffPassword!234', skills: [photography.required_skill] } });
  await expectStatus(response, 201, 'create service-qualified staff');

  response = await call('/api/register', { method: 'POST', body: { name: 'Test Customer', email: 'customer@test.invalid', phone: '0720000000', password: 'CustomerPassword!234', confirm_password: 'CustomerPassword!234' } });
  await expectStatus(response, 200, 'register customer');
  response = await call('/api/admin/customer-records', { cookie: adminCookie });
  await expectStatus(response, 200, 'admin can access customer Records');
  assert.ok(response.data.some((row) => row.email === 'customer@test.invalid' && row.phone === '0720000000' && row.booking_count === 0), 'customer records include safe contact and account summary fields');
  response = await call('/api/admin/customer-records');
  await expectStatus(response, 401, 'customer Records are unavailable without administrator sign-in');
  response = await call('/api/login', { method: 'POST', body: { email: 'customer@test.invalid', password: 'CustomerPassword!234' } });
  await expectStatus(response, 200, 'customer sign in');
  const customerCookie = response.cookie;
  assert.ok(customerCookie, 'customer session cookie is set');

  response = await call('/api/admin/dashboard', { cookie: customerCookie });
  await expectStatus(response, 403, 'customer cannot access admin dashboard');
  response = await call('/api/customer/bookings', { cookie: adminCookie });
  await expectStatus(response, 403, 'administrator cannot access customer dashboard');

  const futureDate = (days) => {
    const date = new Date();
    date.setDate(date.getDate() + days);
    return date.toLocaleDateString('en-CA', { timeZone: 'Africa/Johannesburg' });
  };
  async function createBooking(date, time = '14:00') {
    const created = await call('/api/customer/bookings', { method: 'POST', cookie: customerCookie, body: {
      package_id: photographyPackage.id,
      event_type: 'Integration test photoshoot',
      event_date: date,
      start_time: time,
      duration_minutes: photographyPackage.duration_minutes || 60,
      guests: 2,
      details: 'Automated integration test booking',
      payment_proof: { name: 'proof.png', type: 'image/png', data: 'data:image/png;base64,iVBORw0KGgo=' },
    } });
    await expectStatus(created, 201, 'submit booking and payment proof');
    const adminDashboard = await call('/api/admin/dashboard', { cookie: adminCookie });
    await expectStatus(adminDashboard, 200, 'load admin booking queue');
    const booking = adminDashboard.data.bookings.find((item) => item.reference === created.data.reference);
    assert.ok(booking, 'submitted booking appears in admin queue');
    return booking;
  }

  const booking = await createBooking(futureDate(20));
  response = await call('/api/admin/payment-review', { method: 'POST', cookie: adminCookie, body: { booking_id: booking.id, approve: true, amount_received: 450 } });
  await expectStatus(response, 200, 'verify payment and record amount actually paid');
  assert.equal(response.data.staffAssigned, true, 'qualified staff assigned after payment approval');
  response = await call('/api/staff/login', { method: 'POST', body: { email: 'staff@test.invalid', password: 'StaffPassword!234' } });
  await expectStatus(response, 200, 'staff sign in');
  const staffCookie = response.cookie;
  response = await call('/api/admin/customer-records', { cookie: staffCookie });
  await expectStatus(response, 403, 'staff cannot access administrator customer Records');
  response = await call('/api/staff/tasks', { cookie: staffCookie });
  await expectStatus(response, 200, 'staff sees assigned task');
  assert.ok(response.data.some((task) => task.booking_id === booking.id), 'booking task belongs to qualified staff before cancellation');

  response = await call('/api/customer/cancellation-requests', { method: 'POST', cookie: customerCookie, body: { booking_id: booking.id, reason: 'Customer changed plans' } });
  await expectStatus(response, 201, 'customer requests cancellation');
  assert.equal(response.data.calculated_refund_amount, 450, '7+ day policy returns 100% of amount actually paid');
  const duplicate = await call('/api/customer/cancellation-requests', { method: 'POST', cookie: customerCookie, body: { booking_id: booking.id, reason: 'Duplicate request' } });
  await expectStatus(duplicate, 409, 'duplicate cancellation request is prevented');

  response = await call('/api/admin/dashboard', { cookie: adminCookie });
  await expectStatus(response, 200, 'admin views cancellation queue');
  const cancellation = response.data.cancellationRequests.find((item) => item.id === response.data.cancellationRequests[0]?.id && item.reference === booking.reference);
  assert.ok(cancellation, 'admin sees customer, reference, event date, amount paid and refund estimate');
  response = await call('/api/admin/cancellation-requests', { method: 'PATCH', cookie: adminCookie, body: { request_id: cancellation.id, decision: 'approve', refund_amount: 450 } });
  await expectStatus(response, 200, 'admin approves cancellation and refund');
  assert.equal(response.data.refund_status, 'Pending', 'approved refund starts Pending');
  response = await call('/api/staff/tasks', { cookie: staffCookie });
  await expectStatus(response, 200, 'staff tasks after cancellation');
  assert.ok(!response.data.some((task) => task.booking_id === booking.id), 'cancelled booking is released from staff task list');

  response = await call('/api/admin/dashboard', { cookie: adminCookie });
  const approved = response.data.cancellationRequests.find((item) => item.reference === booking.reference);
  assert.equal(approved.booking_status, 'Cancelled', 'booking status becomes Cancelled separately from refund status');
  assert.equal(approved.refund_status, 'Pending', 'refund remains Pending until transfer is recorded');
  assert.equal(approved.amount_paid, 450, 'recorded paid amount is preserved');
  const refundId = approved.refund_id;
  response = await call('/api/admin/refunds', { method: 'PATCH', cookie: adminCookie, body: { refund_id: refundId, status: 'Processed', money_sent: true } });
  await expectStatus(response, 400, 'processed refund requires transfer reference');
  response = await call('/api/admin/refunds', { method: 'PATCH', cookie: adminCookie, body: { refund_id: refundId, status: 'Failed' } });
  await expectStatus(response, 400, 'failed refund requires a reason');
  response = await call('/api/admin/refunds', { method: 'PATCH', cookie: adminCookie, body: { refund_id: refundId, status: 'Failed', failure_reason: 'Test failure recorded' } });
  await expectStatus(response, 200, 'admin records failed refund with reason');
  response = await call('/api/admin/refunds', { method: 'PATCH', cookie: adminCookie, body: { refund_id: refundId, status: 'Pending' } });
  await expectStatus(response, 200, 'admin can return failed refund to Pending after follow-up');
  response = await call('/api/admin/refunds', { method: 'PATCH', cookie: adminCookie, body: { refund_id: refundId, status: 'Processed', money_sent: true, transfer_reference: 'BANK-TEST-001' } });
  await expectStatus(response, 200, 'admin records externally sent refund');
  response = await call('/api/admin/refunds', { method: 'PATCH', cookie: adminCookie, body: { refund_id: refundId, status: 'Processed', money_sent: true, transfer_reference: 'BANK-TEST-002' } });
  await expectStatus(response, 409, 'duplicate processing of refund is prevented');
  response = await call('/api/customer/bookings', { cookie: customerCookie });
  await expectStatus(response, 200, 'customer views cancellation and refund history');
  const history = response.data.cancellations.find((item) => item.reference === booking.reference);
  assert.equal(history.status, 'Approved', 'customer history records cancellation decision');
  assert.equal(history.refund_status, 'Processed', 'customer history records processed refund status');
  assert.equal(history.transfer_reference, 'BANK-TEST-001', 'customer history shows bank transfer reference');
  response = await call('/api/notifications', { cookie: customerCookie });
  await expectStatus(response, 200, 'customer receives in-app cancellation/refund updates');
  assert.ok(response.data.some((notification) => notification.message.includes('cancellation') && notification.message.includes('approved')), 'customer notification records cancellation decision');
  assert.ok(response.data.some((notification) => notification.message.includes('Processed') && notification.message.includes('BANK-TEST-001')), 'customer notification records refund decision and transfer reference');

  async function verifyAmount(testBooking, amount = 450) {
    const result = await call('/api/admin/payment-review', { method: 'POST', cookie: adminCookie, body: { booking_id: testBooking.id, approve: true, amount_received: amount } });
    await expectStatus(result, 200, 'admin verifies payment for policy test');
  }
  const partialBooking = await createBooking(futureDate(5), '10:00');
  await verifyAmount(partialBooking);
  response = await call('/api/customer/cancellation-requests', { method: 'POST', cookie: customerCookie, body: { booking_id: partialBooking.id, reason: 'Partial-policy test' } });
  await expectStatus(response, 201, 'request cancellation inside 3–6 day window');
  assert.equal(response.data.calculated_refund_amount, 225, '3–6 day policy returns 50% of total paid');
  const partialRequest = response.data.request_id;
  response = await call('/api/admin/cancellation-requests', { method: 'PATCH', cookie: adminCookie, body: { request_id: partialRequest, decision: 'approve', refund_amount: 450.01 } });
  await expectStatus(response, 400, 'refund cannot exceed amount actually paid');
  response = await call('/api/admin/cancellation-requests', { method: 'PATCH', cookie: adminCookie, body: { request_id: partialRequest, decision: 'approve', refund_amount: 225 } });
  await expectStatus(response, 200, 'admin approves partial refund');
  assert.equal(response.data.approved_refund_amount, 225, 'partial refund amount recorded');

  const noRefundBooking = await createBooking(futureDate(2), '11:00');
  await verifyAmount(noRefundBooking);
  response = await call('/api/customer/cancellation-requests', { method: 'POST', cookie: customerCookie, body: { booking_id: noRefundBooking.id, reason: 'No-refund policy test' } });
  await expectStatus(response, 201, 'request cancellation inside 0–2 day window');
  assert.equal(response.data.calculated_refund_amount, 0, '0–2 day policy returns no refund');
  response = await call('/api/admin/cancellation-requests', { method: 'PATCH', cookie: adminCookie, body: { request_id: response.data.request_id, decision: 'approve', refund_amount: 0 } });
  await expectStatus(response, 200, 'admin records no-refund cancellation decision');
  assert.equal(response.data.refund_status, null, 'no-refund cancellation does not create a fake payment/refund transaction');

  const rejectedBooking = await createBooking(futureDate(25), '09:00');
  response = await call('/api/customer/cancellation-requests', { method: 'POST', cookie: customerCookie, body: { booking_id: rejectedBooking.id, reason: 'Cancellation rejection test' } });
  await expectStatus(response, 201, 'customer submits cancellation for rejection test');
  response = await call('/api/admin/cancellation-requests', { method: 'PATCH', cookie: adminCookie, body: { request_id: response.data.request_id, decision: 'reject' } });
  await expectStatus(response, 400, 'rejection requires a reason');
  const rejectedRequestId = (await call('/api/admin/dashboard', { cookie: adminCookie })).data.cancellationRequests.find((item) => item.reference === rejectedBooking.reference).id;
  response = await call('/api/admin/cancellation-requests', { method: 'PATCH', cookie: adminCookie, body: { request_id: rejectedRequestId, decision: 'reject', reason: 'The booking can still go ahead.' } });
  await expectStatus(response, 200, 'admin rejects request with reason');
  response = await call('/api/customer/bookings', { cookie: customerCookie });
  assert.equal(response.data.cancellations.find((item) => item.reference === rejectedBooking.reference).rejection_reason, 'The booking can still go ahead.', 'customer sees cancellation rejection reason');

  const venueBooking = await createBooking(futureDate(40), '12:00');
  await verifyAmount(venueBooking, 300);
  response = await call('/api/admin/venue-cancellations', { method: 'POST', cookie: adminCookie, body: { booking_id: venueBooking.id, reason: 'Venue unavailable' } });
  await expectStatus(response, 200, 'Escape Villa records venue cancellation');
  assert.equal(response.data.refund_amount, 300, 'venue cancellation qualifies for 100% of amount actually paid');
  const venueData = await call('/api/admin/dashboard', { cookie: adminCookie });
  const venueRequest = venueData.data.cancellationRequests.find((item) => item.reference === venueBooking.reference);
  assert.equal(venueRequest.request_type, 'venue', 'venue cancellation is identified separately');
  assert.equal(venueRequest.refund_status, 'Pending', 'venue cancellation refund begins Pending');

  const rescheduleBooking = await createBooking(futureDate(30), '16:00');
  const availabilityBooking = await createBooking(futureDate(31), '10:00');
  const collisionRequest = await call('/api/customer/reschedule-requests', { method: 'POST', cookie: customerCookie, body: { booking_id: rescheduleBooking.id, event_date: futureDate(31), start_time: '10:30', reason: 'Collision test' } });
  await expectStatus(collisionRequest, 409, 'rescheduling availability is checked against existing booking time');
  response = await call('/api/customer/reschedule-requests', { method: 'POST', cookie: customerCookie, body: { booking_id: rescheduleBooking.id, event_date: futureDate(31), start_time: '17:00', reason: 'Change of date' } });
  await expectStatus(response, 201, 'customer requests one reschedule');
  const secondReschedule = await call('/api/customer/reschedule-requests', { method: 'POST', cookie: customerCookie, body: { booking_id: rescheduleBooking.id, event_date: futureDate(32), start_time: '17:00', reason: 'Another date' } });
  await expectStatus(secondReschedule, 409, 'only one reschedule request allowed');
  const adminData = await call('/api/admin/dashboard', { cookie: adminCookie });
  const reschedule = adminData.data.rescheduleRequests.find((item) => item.reference === rescheduleBooking.reference);
  assert.ok(reschedule, 'admin sees reschedule request');
  response = await call('/api/admin/reschedule-requests', { method: 'PATCH', cookie: adminCookie, body: { request_id: reschedule.id, decision: 'approve' } });
  await expectStatus(response, 200, 'admin approves available reschedule');
  const customerData = await call('/api/customer/bookings', { cookie: customerCookie });
  assert.equal(customerData.data.bookings.find((item) => item.id === rescheduleBooking.id).event_date, futureDate(31), 'approved date is reflected in customer booking');
  assert.equal(customerData.data.reschedules.find((item) => item.reference === rescheduleBooking.reference).status, 'Approved', 'reschedule history is visible to customer');

  console.log('PASS: setup, editable policy, role-protected customer Records, customer registration/sign-in, staff qualification, booking/payment, permissions, 7+ day/3–6 day/0–2 day refund calculations, venue full refund, cancellation duplicate guard, admin approve/reject and rejection reason, customer cancellation/refund notices, staff release, refund amount validation, Pending/Failed/Processed status guards, duplicate processing guard, customer history, one-time rescheduling, and reschedule availability.');
}

try {
  await run();
} finally {
  server.kill();
  await new Promise((resolve) => server.once('exit', resolve));
  await rm(tempDirectory, { recursive: true, force: true });
}
