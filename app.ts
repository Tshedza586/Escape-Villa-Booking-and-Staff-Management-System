type Role = 'customer' | 'admin' | 'staff';
type User = { id: number; name: string; email: string; phone?: string; role: Role; skills?: string };
type Service = { id: number; name: string; description: string; required_skill: string };
type Package = { id: number; service_id: number; service_name: string; name: string; price: number; price_from: number; duration_minutes: number | null; description: string };
type Booking = { id: number; reference: string; service: string; package_name?: string; package_price?: number | null; package_price_from?: number; event_date: string; start_time: string; venue: string; status: string; payment_status?: string; evidence_received?: number; amount_paid?: number | null; cancellation_status?: string | null; pending_cancellation_id?: number | null; reschedule_request_count?: number; reschedule_status?: string | null };
type CancellationPolicy = { fullRefundDays: number; partialRefundDays: number; partialRefundPercent: number };
type CancellationHistory = { id: number; booking_id: number; request_type: string; status: string; reason: string; rejection_reason?: string | null; calculated_refund_amount: number; approved_refund_amount: number; requested_at: string; reviewed_at?: string | null; reference: string; event_date: string; refund_amount?: number | null; refund_status?: string | null; transfer_reference?: string | null; failure_reason?: string | null; processed_at?: string | null };
type RescheduleHistory = { id: number; booking_id: number; requested_json: string; reason: string; status: string; response: string; created_at: string; reference: string; event_date: string; start_time: string };
type Activity = { id: number; actor_name: string; actor_role: string; action: string; entity: string; entity_id: string; details: string; created_at: string };
type EscapeReport = { period: string; selectedDate: string; startDate: string; endDateExclusive: string; summary: { totalBookings: number; confirmed: number; cancelled: number; completedTasks: number; totalTasks: number; paymentAmount: number }; byService: Array<{ label: string; count: number }>; byStatus: Array<{ label: string; count: number }>; paymentStatuses: Array<{ label: string; count: number }>; tasks: Array<{ label: string; count: number }>; bookings: Array<Record<string, string | number | null>>; activity: Activity[] };
type ApiError = { error?: string };

const app = document.querySelector<HTMLElement>('#app');
if (!app) throw new Error('Missing #app root element');
let currentUser: User | null = null;
let services: Service[] = [];
let packages: Package[] = [];
let siteDataLoaded = false;
let sessionLoaded = false;
const htmlEscapes: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeHtml = (value: unknown): string => String(value ?? '').replace(/[&<>"']/g, (char) => htmlEscapes[char]);
const todayLocal = (): string => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; };

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, { credentials: 'same-origin', ...init, headers: { ...(init.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }), ...init.headers } });
  const payload = await response.json() as T & ApiError;
  if (!response.ok) throw new Error(payload.error || 'Request could not be completed.');
  return payload;
}
function header(): string {
  return `<header class="nav"><a class="brand" href="/">Escape Villa<span>GREEK-INSPIRED VILLA · POLOKWANE</span></a><nav><a href="/about">About</a><a href="/services">Services</a><a href="/gallery">Gallery</a><a href="/contact">Contact</a>${currentUser ? `<a href="/${currentUser.role}/dashboard">My portal</a>${currentUser.role==='admin'?'<a href="/admin/reports">Reports</a>':''}${currentUser.role!=='customer'?`<a href="/${currentUser.role}/settings">Settings</a>`:''}` : '<a href="/register">Sign Up</a>'}</nav></header>`;
}
function footer(): string { return `<footer><div><strong>Escape Villa SA</strong><p>38 Voortrekker Street<br>Polokwane Central, South Africa</p><p><a href="tel:+27713714050">071 371 4050</a></p></div><div><a href="/privacy">Privacy</a><a href="/terms">Terms</a><p>Photography · Videography · Venue hire · Beauty · Private dining</p></div></footer>`; }
function frame(content: string): string { return `${header()}${content}${footer()}`; }
function page(title: string, subtitle: string, body: string): string { return frame(`<section class="page-head"><span>ESCAPE VILLA</span><h1>${title}</h1><p>${subtitle}</p></section><main class="container">${body}</main>`); }
function serviceImage(service: Service): [string, string] {
  const name = service.name.toLowerCase();
  if (name.includes('photo')) return ['/images/gallery/13-graduation-photography.jpg', 'Graduation photography at Escape Villa'];
  if (name.includes('video')) return ['/images/gallery/05-portrait-session.jpeg', 'Creative portrait session'];
  if (name.includes('event')) return ['/images/gallery/08-event-table.jpeg', 'Event table styling'];
  if (name.includes('makeup')) return ['/images/gallery/14-makeup-glam.jpg', 'Glam makeup and beauty styling at Escape Villa'];
  return ['/images/gallery/15-romantic-private-dinner.jpg', 'Couple enjoying a romantic private dinner at Escape Villa'];
}
function serviceMediaMarkup(service: Service, booking = false): string {
  const [image, alt] = serviceImage(service);
  const className = booking ? 'booking-service-image' : 'service-image';
  if (service.name.toLowerCase().includes('video')) return `<video class="${className}" controls playsinline preload="none" poster="${image}" aria-label="Videography sample video"><source src="/videos/videography-sample.mp4" type="video/mp4">Your browser does not support video playback.</video>`;
  return `<img class="${className}" src="${image}" alt="${escapeHtml(alt)}" loading="lazy">`;
}
function servicesMarkup(): string { return `<div class="cards">${services.map((service, index) => `<article class="card service-card">${serviceMediaMarkup(service)}<div class="number">0${index + 1}</div><h2>${escapeHtml(service.name)}</h2><p>${escapeHtml(service.description)}</p><a href="/book?service=${service.id}">Choose a package →</a></article>`).join('')}</div>`; }
function packagePriceLabel(pkg: Pick<Package, 'price' | 'price_from'>): string { return `${pkg.price_from ? 'From ' : ''}R ${pkg.price.toLocaleString('en-ZA')}`; }
function packageDetailsMarkup(pkg: Package): string { return `<p class="package-price">${packagePriceLabel(pkg)}</p><ul class="package-inclusions">${pkg.description.split('|').map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`; }
function packagesMarkup(): string { return services.map((service) => { const choices = packages.filter((pkg) => pkg.service_id === service.id); return choices.length ? `<section class="package-group"><h2 class="serif">${escapeHtml(service.name)} packages</h2><div class="cards">${choices.map((pkg) => `<article class="card"><h3>${escapeHtml(pkg.name)}</h3>${packageDetailsMarkup(pkg)}<a href="/book?package=${pkg.id}">Book this package →</a></article>`).join('')}</div>${service.name === 'Event Planning' ? '<p class="muted">Venue hire, catering, décor rentals and supplier costs are quoted separately unless explicitly included in the agreed package.</p>' : ''}</section>` : ''; }).join(''); }
function selectedPackageMarkup(pkg?: Package): string { return pkg ? `<div class="package-selection"><h3>${escapeHtml(pkg.name)} · ${escapeHtml(pkg.service_name)}</h3>${packageDetailsMarkup(pkg)}</div>` : '<p class="muted">Choose a package to see its price and inclusions.</p>'; }
function renderHome(): void {
  app!.innerHTML = frame(`<section class="hero"><div class="hero-copy"><span>ESCAPE VILLA SA · POLOKWANE</span><h1>Make room for<br><i>meaningful moments.</i></h1><p>A Greek-inspired outdoor villa for photo, film and video shoots, intimate events, beauty appointments and romantic private dinners.</p><a class="text-link" href="/services">Explore our services ↗</a></div><div class="hero-note">38 VOORTREKKER STREET<br>POLOKWANE CENTRAL · UP TO 45 GUESTS</div></section><section class="container section"><span class="eyebrow">A BACKYARD SETTING WITH A GREEK-INSPIRED FEEL</span><h2 class="display">A beautiful space<br>for your next occasion.</h2>${servicesMarkup()}<p class="muted">Venue rates depend on the number of guests. Maximum capacity is 45 people. Appointments only; no walk-ins.</p></section><section class="mission"><div><span class="eyebrow">ESCAPE VILLA SA</span><p>From maternity and graduation shoots to baby showers, celebrations and private dinners, Escape Villa brings the setting and creative services together in one place.</p><a class="text-link" href="/about">More about Escape Villa →</a></div></section>`);
}
function renderServices(): void { app!.innerHTML = page('Services & packages', 'Choose a package for photography, videography, event planning, makeup or private dining. Proposed website package prices are shown in South African rand.', `${servicesMarkup()}${packagesMarkup()}<p class="muted">All visits are by appointment. No walk-ins. Event venue hire, catering, décor rentals and supplier costs are quoted separately unless explicitly included in the agreed package.</p>`); }
function renderAbout(): void {
  app!.innerHTML = page('About Escape Villa SA', 'A Greek-inspired outdoor villa and creative space in Polokwane Central.', `<div class="facts"><div><small>SETTING</small><b>Greek-inspired outdoor backyard</b></div><div><small>CAPACITY</small><b>Up to 45 people</b></div><div><small>ADDRESS</small><b>38 Voortrekker Street, Polokwane Central</b></div></div><h2 class="serif">A space for creative experiences</h2><p class="copy">Escape Villa is an outdoor backyard setting for photo shoots, film and video shoots, and small events. The space is inspired by Greek aesthetics and can host creative experiences, launches, pop-up stores and special occasions.</p><div class="two-col"><div><h2 class="serif">Photography, video & beauty</h2><p class="copy">Book professional photography for maternity, birthday, graduation, corporate or brand shoots, as well as videography. Makeup, hair installation and styling are also available by appointment.</p></div><div><h2 class="serif">Events & private dining</h2><p class="copy">Host a baby shower, birthday celebration, graduation party or year-end function with venue hire, décor and catering by arrangement. Romantic private dinners include a three-course meal and a romantic setup.</p></div></div><div class="callout"><strong>Planning a visit?</strong><p>Maximum capacity is 45 people. Venue rates depend on the number of people attending. Escape Villa is appointment only; there are no walk-ins.</p><p>Weekdays: 7:00 AM–9:00 PM<br>Saturday and Sunday: 6:00 AM–10:00 PM</p></div>`);
}
function renderGallery(): void {
  const photos = [
    ['01-maternity-holiday.jpeg', 'Maternity holiday portrait'],
    ['02-white-interior.jpeg', 'White villa interior'],
    ['03-family-portrait.jpeg', 'Family portrait'],
    ['04-arched-interior.jpeg', 'Arched villa interior'],
    ['05-portrait-session.jpeg', 'Portrait session'],
    ['06-villa-patio.jpeg', 'Villa patio and event setup'],
    ['07-family-maternity.jpeg', 'Family maternity portrait'],
    ['08-event-table.jpeg', 'Event table setting'],
    ['09-maternity-red.jpeg', 'Maternity portrait'],
    ['10-pool-event-setup.jpeg', 'Poolside event setup'],
    ['11-dining-decoration.jpeg', 'Dining table decoration'],
    ['12-graduation-portrait.jpeg', 'Graduation portrait'],
    ['13-graduation-photography.jpg', 'Graduation photography at Escape Villa'],
    ['14-makeup-glam.jpg', 'Glam makeup and beauty styling at Escape Villa'],
    ['15-romantic-private-dinner.jpg', 'Couple enjoying a romantic private dinner at Escape Villa'],
  ];
  app!.innerHTML = page('Gallery', 'A selection of Escape Villa photography and event work.', `<div class="gallery">${photos.map(([photo, description]) => `<img alt="${description}" loading="lazy" src="/images/gallery/${photo}">`).join('')}</div>`);
}
function renderContact(): void {
  app!.innerHTML = page('Contact & hours', 'Visits and bookings are by appointment. Please contact Escape Villa before coming through; there are no walk-ins.', `<div class="two-col"><div><h2 class="serif">Contact Escape Villa</h2><p class="copy">38 Voortrekker Street<br>Polokwane Central, South Africa</p><p><a class="button" href="https://wa.me/27713714050?text=Hello%20Escape%20Villa%2C%20I%20would%20like%20to%20book%20a%20service." target="_blank" rel="noopener noreferrer">Chat on WhatsApp</a></p><p><a class="button" href="https://www.instagram.com/escape_villa_sa/" target="_blank" rel="noopener noreferrer">Message on Instagram</a></p><p><a href="tel:+27713714050">Call 071 371 4050</a><br><a href="https://www.tiktok.com/@Escape.Villa.sa" target="_blank" rel="noopener noreferrer">TikTok: Escape.Villa.sa</a></p><h2 class="serif">Operating hours</h2><p class="copy">Monday–Friday: 7:00 AM–9:00 PM<br>Saturday & Sunday: 6:00 AM–10:00 PM</p><p class="muted">No walk-ins. Please book a service before visiting.</p></div><form data-form="contact" class="form"><label>Full name<input name="name" required></label><label>Email<input name="email" type="email" required></label><label>Contact number<input name="phone" required></label><label>Subject<input name="subject" required></label><label>Message<textarea name="message" required></textarea></label><button class="button">Send enquiry</button></form></div>`);
}
function renderAuth(kind: 'login' | 'register' | 'admin' | 'staff' | 'setup' | 'recover'): void {
  const isRegister = kind === 'register';
  const setup = kind === 'setup';
  const recover = kind === 'recover';
  const next = new URLSearchParams(location.search).get('next');
  const nextQuery = next && next.startsWith('/') && !next.startsWith('//') ? `?next=${encodeURIComponent(next)}` : '';
  const emailPrefill = kind === 'login' ? new URLSearchParams(location.search).get('email') || '' : '';
  const passwordField = (label: string, name: string, autocomplete: string, minlength = '') => `<label>${label}<span class="password-control"><input name="${name}" type="password" ${minlength ? `minlength="${minlength}"` : ''} required autocomplete="${autocomplete}"><button type="button" class="password-toggle" data-password-toggle aria-label="Show password">Show</button></span></label>`;
  app!.innerHTML = page(recover ? 'Recover administrator account' : setup ? 'Administrator setup' : isRegister ? 'Sign Up' : kind === 'admin' ? 'Administrator log in' : kind === 'staff' ? 'Staff log in' : 'Log in', recover ? 'Use the recovery key configured privately on the server to reset the administrator login.' : 'Secure access to your Escape Villa portal.', `<form data-form="${kind}" class="form narrow">${isRegister || setup || recover ? `<label>Full name<input name="name" ${recover ? 'autocomplete="name"' : ''} required></label>${isRegister || setup ? '<label>Contact number<input name="phone"></label>' : ''}` : ''}${setup ? '<label>One-time setup key<input name="setup_key" type="password" required></label>' : recover ? '<label>Administrator recovery key<input name="recovery_key" type="password" autocomplete="off" required></label>' : ''}<label>${recover ? 'New admin email' : 'Email'}<input name="email" type="email" value="${escapeHtml(emailPrefill)}" required autocomplete="email"></label>${passwordField(recover ? 'New password' : 'Password', 'password', recover ? 'new-password' : 'current-password', isRegister || recover ? '10' : '')}${isRegister ? passwordField('Confirm password', 'confirm_password', 'new-password', '10') : recover ? passwordField('Confirm new password', 'confirm_password', 'new-password', '10') : ''}<button class="button">${isRegister ? 'Sign Up' : setup ? 'Create administrator' : recover ? 'Reset administrator login' : 'Log in'}</button>${isRegister ? `<p>Already registered? <a href="/login${nextQuery}">Log in</a></p>` : kind === 'login' ? `<p>Not registered yet? <a href="/register${nextQuery}">Sign Up</a> · <a href="/admin/login">Administrator</a> · <a href="/staff/login">Staff</a></p>` : kind === 'admin' ? '<p><a href="/admin/recover">Forgot your login details?</a></p>' : recover ? '<p><a href="/admin/login">Back to administrator login</a></p>' : ''}</form>`);
}
function renderAdminReset(): void {
  app!.innerHTML = page('Reset all accounts', 'This permanently erases login accounts and their linked booking data.', `<div class="callout"><p><strong>Data that will be erased:</strong> every admin, staff and customer account; bookings; payments; staff assignments and tasks; booking changes; notifications; and activity reports.</p><p>Escape Villa services and settings, and contact enquiries, will remain. After the reset, create a fresh administrator at <a href="/admin/setup">/admin/setup</a>. This reset is one-use and requires private keys configured by the site owner.</p></div><form data-form="reset-all" class="form narrow"><label>One-time reset key<input name="reset_key" type="password" autocomplete="off" required></label><label>Type ERASE ALL ACCOUNTS to confirm<input name="confirmation" required autocomplete="off"></label><button class="button">Erase accounts and linked data</button></form><p><a href="/admin/login">Back to administrator login</a></p>`);
}
function bookingCalendarMarkup(month: string, bookedDates: Set<string>, selectedDate: string): string {
  const [year, monthNumber] = month.split('-').map(Number);
  const firstWeekday = new Date(year, monthNumber - 1, 1).getDay();
  const daysInMonth = new Date(year, monthNumber, 0).getDate();
  const monthLabel = new Intl.DateTimeFormat('en-ZA', { month: 'long', year: 'numeric' }).format(new Date(year, monthNumber - 1, 1));
  const today = todayLocal();
  const cells = Array.from({ length: firstWeekday }, () => '<span class="calendar-empty" aria-hidden="true"></span>');
  for (let day = 1; day <= daysInMonth; day++) {
    const date = `${month}-${String(day).padStart(2, '0')}`;
    const isBooked = bookedDates.has(date);
    const selected = selectedDate === date;
    const past = date < today;
    cells.push(`<button type="button" class="calendar-day${isBooked ? ' booked-date' : ''}${selected ? ' selected-date' : ''}" data-calendar-date="${date}" ${past ? 'disabled' : ''} ${isBooked ? 'title="A booking exists on this date; other times may still be available."' : ''} aria-pressed="${selected}">${day}</button>`);
  }
  return `<div class="calendar-header"><button type="button" data-calendar-prev aria-label="Previous month">‹</button><strong>${escapeHtml(monthLabel)}</strong><button type="button" data-calendar-next aria-label="Next month">›</button></div><div class="calendar-grid calendar-weekdays" aria-hidden="true">${['Su','Mo','Tu','We','Th','Fr','Sa'].map((day) => `<span>${day}</span>`).join('')}</div><div class="calendar-grid" role="group" aria-label="${escapeHtml(monthLabel)} booking dates">${cells.join('')}</div>`;
}
function renderBooking(): void {
  const query = new URLSearchParams(location.search);
  const requestedPackage = query.get('package') || '';
  const requestedService = query.get('service') || '';
  const linkedPackage = packages.find((pkg) => String(pkg.id) === requestedPackage);
  const initialServiceId = linkedPackage?.service_id
    || Number(requestedService)
    || services.find((service) => packages.some((pkg) => pkg.service_id === service.id))?.id;
  const initialPackages = packages.filter((pkg) => pkg.service_id === initialServiceId);
  const defaultPackage = initialPackages.find((pkg) => String(pkg.id) === requestedPackage) || initialPackages[0];
  const initialService = services.find((service) => service.id === initialServiceId);
  const [bookingImage, bookingImageAlt] = initialService ? serviceImage(initialService) : ['/images/gallery/02-white-interior.jpeg', 'Escape Villa service setting'];
  const serviceOptions = services
    .filter((service) => packages.some((pkg) => pkg.service_id === service.id))
    .map((service) => `<option value="${service.id}" ${service.id === initialServiceId ? 'selected' : ''}>${escapeHtml(service.name)}</option>`)
    .join('');
  const packageOptions = initialPackages
    .map((pkg) => `<option value="${pkg.id}" ${pkg.id === defaultPackage?.id ? 'selected' : ''}>${escapeHtml(pkg.name)} — ${escapeHtml(packagePriceLabel(pkg))}</option>`)
    .join('');
  const calendarMonth = todayLocal().slice(0, 7);
  app!.innerHTML = page('Book a service', 'Choose a service package, upload proof of payment, and submit your booking request. The team will confirm availability and any separately quoted costs.', `<div class="two-col"><aside class="callout"><div id="booking-service-media">${initialService ? serviceMediaMarkup(initialService, true) : `<img class="booking-service-image" src="${bookingImage}" alt="${escapeHtml(bookingImageAlt)}">`}</div><h2 class="serif">Your selected package</h2><div id="package-selection">${selectedPackageMarkup(defaultPackage)}</div><p>Maximum capacity is 45 people. Prices shown are proposed; your request is not confirmed until the team reviews it and contacts you.</p><p>Venue hire, catering, décor rentals and supplier costs are quoted separately unless explicitly included in the agreed package.</p></aside><form data-form="booking" class="form"><label>Choose a service<select name="service_id" required>${serviceOptions}</select></label><label>Choose a package<select name="package_id" required>${packageOptions}</select></label><label>Event type<input name="event_type"></label><div class="booking-date-field"><span class="form-label">Event date</span><input type="hidden" name="event_date" value=""><p id="selected-date-label" class="muted">Choose a date from the calendar.</p><p id="booking-calendar-status" class="muted" aria-live="polite">Loading booked dates…</p><div id="booking-calendar" class="booking-calendar" data-month="${calendarMonth}">${bookingCalendarMarkup(calendarMonth, new Set(), '')}</div><p class="calendar-legend"><span class="legend-booked"></span> Existing booking on this date (other times may be available)</p></div><label>Preferred start time<input name="start_time" type="time" required></label><label>Requested booking duration in minutes<input name="duration_minutes" type="number" min="30" value="${defaultPackage?.duration_minutes || 60}"></label><p class="muted">Location: Escape Villa, 38 Voortrekker Street, Polokwane Central.</p><label>Expected guests (maximum 45)<input name="guests" type="number" min="1" max="45"></label><label>Special requests<textarea name="details"></textarea></label><section class="callout banking-details"><h2 class="serif">Escape Villa — Banking details</h2><p><strong>Account holder:</strong> Escape Villa<br><strong>Bank name:</strong> FNB<br><strong>Account number:</strong> 658633093<br><strong>Account type:</strong> Business Account<br><strong>Branch code:</strong> 8475<br><strong>Reference:</strong> Customer Name</p></section><label>Proof of payment (JPG, PNG, WebP or PDF; max 3 MB)<input name="payment_proof" type="file" accept="image/jpeg,image/png,image/webp,application/pdf" required></label><p class="muted">Use the customer name as your payment reference, then upload your proof of payment.</p><button class="button">Submit service booking</button></form></div>`);
}
async function renderPortal(): Promise<void> {
  if (!currentUser) { location.assign('/login'); return; }
  if (currentUser.role === 'customer') {
    const management = await request<{bookings:Booking[];cancellations:CancellationHistory[];reschedules:RescheduleHistory[];policy:CancellationPolicy}>('/api/customer/bookings');
    const bookingRows = management.bookings.map((b) => {
      const terminal = ['Completed','Cancelled','Declined'].includes(b.status);
      const cancellationAction = terminal ? '—' : b.pending_cancellation_id ? '<span class="status-pill">Cancellation pending</span>' : `<form data-form="cancellation-request" class="inline-action"><input type="hidden" name="booking_id" value="${b.id}"><label>Reason (optional)<input name="reason" maxlength="500"></label><button class="button button-secondary">Request cancellation</button></form>`;
      const rescheduleAction = terminal ? '' : Number(b.reschedule_request_count || 0) > 0 ? `<span class="muted">Reschedule: ${escapeHtml(b.reschedule_status || 'Requested')}</span>` : `<form data-form="reschedule-request" class="inline-action"><input type="hidden" name="booking_id" value="${b.id}"><label>New date<input name="event_date" type="date" min="${todayLocal()}" required></label><label>New time<input name="start_time" type="time" required></label><label>Reason (optional)<input name="reason" maxlength="500"></label><button class="button button-secondary">Request one reschedule</button></form>`;
      return `<tr><td>${escapeHtml(b.reference)}</td><td>${escapeHtml(b.service)}<br>${escapeHtml(b.package_name || '—')}${b.package_price != null ? ` · ${packagePriceLabel({ price: b.package_price, price_from: b.package_price_from || 0 })}` : ''}</td><td>${escapeHtml(b.event_date)} · ${escapeHtml(b.start_time)}</td><td>${escapeHtml(b.status)}</td><td>${escapeHtml(b.payment_status || '—')}<br>Total paid: ${zar(b.amount_paid)}</td><td>${cancellationAction}${rescheduleAction}</td></tr>`;
    }).join('') || '<tr><td colspan="6">No bookings yet.</td></tr>';
    const cancellationHistory = management.cancellations.map((c) => `<tr><td>${escapeHtml(c.reference)}</td><td>${escapeHtml(c.request_type === 'venue' ? 'Escape Villa cancellation' : 'Customer request')}</td><td>${escapeHtml(c.status)}${c.rejection_reason ? `<br><span class="muted">${escapeHtml(c.rejection_reason)}</span>` : ''}</td><td>${zar(c.approved_refund_amount)}</td><td>${escapeHtml(c.refund_status || (c.status === 'Approved' && Number(c.approved_refund_amount) === 0 ? 'No refund due' : '—'))}${c.transfer_reference ? `<br>Transfer ref: ${escapeHtml(c.transfer_reference)}` : ''}${c.failure_reason ? `<br>${escapeHtml(c.failure_reason)}` : ''}</td></tr>`).join('') || '<tr><td colspan="5">No cancellation history yet.</td></tr>';
    const rescheduleHistory = management.reschedules.map((item) => { let newDateTime='Requested date unavailable'; try { const requested=JSON.parse(item.requested_json) as {event_date:string;start_time:string}; newDateTime=`${requested.event_date} ${requested.start_time}`; } catch { /* Keep safe fallback. */ } return `<tr><td>${escapeHtml(item.reference)}</td><td>${escapeHtml(item.event_date)} ${escapeHtml(item.start_time)}</td><td>${escapeHtml(newDateTime)}</td><td>${escapeHtml(item.status)}${item.response ? `<br><span class="muted">${escapeHtml(item.response)}</span>` : ''}</td></tr>`; }).join('') || '<tr><td colspan="4">No rescheduling requests yet.</td></tr>';
    const policyText = `Current cancellation policy: ${management.policy.fullRefundDays}+ days before the booking: full refund; ${management.policy.partialRefundDays}–${management.policy.fullRefundDays - 1} days: ${management.policy.partialRefundPercent}% refund; 0–${Math.max(0, management.policy.partialRefundDays - 1)} days: no refund. Escape Villa cancellations qualify for a full refund. Any refund is calculated from the total amount actually paid, including the deposit.`;
    app!.innerHTML = page(`Welcome, ${escapeHtml(currentUser.name.split(' ')[0])}`, 'Your bookings and account settings.', `<p><a class="button" href="/book">Book</a></p><h2 class="serif">Account details</h2><form data-form="profile" class="form narrow"><label>Full name<input name="name" value="${escapeHtml(currentUser.name)}" required></label><label>Email address<input name="email" type="email" value="${escapeHtml(currentUser.email)}" required></label><label>Contact number<input name="phone" type="tel" value="${escapeHtml(currentUser.phone || '')}"></label><button class="button">Save account details</button><button class="button button-secondary" type="button" data-logout>Log out</button></form><h2 class="serif">Change password</h2><form data-form="password" class="form narrow"><label>Current password<input name="current_password" type="password" autocomplete="current-password" required></label><label>New password (at least 10 characters)<input name="new_password" type="password" autocomplete="new-password" minlength="10" required></label><label>Confirm new password<input name="confirm_password" type="password" autocomplete="new-password" minlength="10" required></label><button class="button">Update password</button></form><h2 class="serif">Your bookings</h2><p class="callout">${escapeHtml(policyText)}</p><div class="table-wrap"><table><thead><tr><th>Reference</th><th>Service</th><th>Date & time</th><th>Booking status</th><th>Payment and total paid</th><th>Actions</th></tr></thead><tbody>${bookingRows}</tbody></table></div><h2 class="serif">Cancellation and refund history</h2><div class="table-wrap"><table><thead><tr><th>Booking</th><th>Type</th><th>Decision</th><th>Approved refund</th><th>Refund status</th></tr></thead><tbody>${cancellationHistory}</tbody></table></div><p class="muted">Refunds are sent by Escape Villa outside the website. A refund shows Processed only after the administrator records that the money was sent and enters its transfer reference.</p><h2 class="serif">Rescheduling history</h2><div class="table-wrap"><table><thead><tr><th>Booking</th><th>Previous date</th><th>Requested date</th><th>Status</th></tr></thead><tbody>${rescheduleHistory}</tbody></table></div>`);
  } else if (currentUser.role === 'admin') {
    if(location.pathname==='/admin/reports'){await renderReports();return;}
    const dashboardPromise = request<{ bookings: Booking[]; staff: User[]; cancellationRequests: Array<CancellationHistory & { customer: string; customer_email: string; customer_phone?: string; amount_paid: number; booking_status: string; refund_id?: number | null }>; rescheduleRequests: Array<{ id:number; requested_json:string; reason:string; status:string; response:string; reference:string; event_date:string; start_time:string; customer:string; customer_email:string }>; policy: CancellationPolicy }>('/api/admin/dashboard');
    const activityPromise = location.pathname === '/admin/dashboard' ? request<Activity[]>('/api/admin/activity') : Promise.resolve([] as Activity[]);
    const [data, activity] = await Promise.all([dashboardPromise, activityPromise]);
    if (location.pathname === '/admin/settings') {
      app!.innerHTML = page('Admin settings', 'Manage administrator login details and staff accounts.', `<p><a class="text-link" href="/admin/dashboard">← Back to administration</a></p><h2 class="serif">Administrator login details</h2><form data-form="admin-account" class="form narrow"><label>Full name<input name="name" value="${escapeHtml(currentUser.name)}" required></label><label>Login email<input name="email" type="email" value="${escapeHtml(currentUser.email)}" required></label><label>Current password<input name="current_password" type="password" autocomplete="current-password" required></label><label>New password (leave blank to keep the current one)<input name="new_password" type="password" autocomplete="new-password" minlength="10"></label><label>Confirm new password<input name="confirm_password" type="password" autocomplete="new-password" minlength="10"></label><button class="button">Save login details</button><button class="button button-secondary" type="button" data-logout>Log out</button><p class="muted">Your current password is required to confirm any changes. New passwords must be at least 10 characters.</p></form><h2 class="serif">Staff accounts</h2><div class="two-col"><form data-form="staff-create" class="form"><label>Full name<input name="name" required></label><label>Email address<input name="email" type="email" required></label><label>Contact number<input name="phone" type="tel"></label><fieldset><legend>Services this staff member handles</legend><div class="service-checks">${services.map((service) => `<label class="check"><input type="checkbox" name="skills" value="${escapeHtml(service.required_skill)}">${escapeHtml(service.name)}</label>`).join('')}</div></fieldset><label>Initial password (at least 10 characters)<input name="password" type="password" minlength="10" autocomplete="new-password" required></label><button class="button">Create staff account</button><p class="muted">Give the staff member their email and initial password. They can sign in at /staff/login.</p></form><aside><h3>Active staff</h3>${data.staff.map((member) => { const memberSkills = String(member.skills || '').split(',').map((skill) => skill.trim()); return `<div class="callout"><strong>${escapeHtml(member.name)}</strong><br><span class="muted">${escapeHtml(member.email)}</span><p><strong>Services:</strong> ${escapeHtml(member.skills || 'None selected')}</p><form data-form="staff-skills" data-staff-user-id="${member.id}" class="form"><fieldset><legend>Services they handle</legend><div class="service-checks">${services.map((service) => `<label class="check"><input type="checkbox" name="skills" value="${escapeHtml(service.required_skill)}" ${memberSkills.includes(service.required_skill) ? 'checked' : ''}>${escapeHtml(service.name)}</label>`).join('')}</div></fieldset><button class="button">Save services</button></form></div>`; }).join('') || '<p class="muted">No staff accounts yet.</p>'}</aside></div>`);
      return;
    }
    app!.innerHTML = page('Administration', 'Booking activity and a record of actions across the site.', `<div class="metrics"><div><small>BOOKINGS</small><b>${data.bookings.length}</b></div><div><small>ACTIVE STAFF</small><b>${data.staff.length}</b></div><div><small>PENDING</small><b>${data.bookings.filter((b) => b.status.startsWith('Pending')).length}</b></div></div><p><a class="button" href="/admin/settings">Admin & staff settings</a></p><h2 class="serif">Recent activity</h2><div class="table-wrap"><table><thead><tr><th>When</th><th>Who</th><th>Activity</th><th>Record</th><th>Details</th></tr></thead><tbody>${activity.slice(0,10).map((entry)=>`<tr><td>${escapeHtml(new Date(entry.created_at).toLocaleString())}</td><td>${escapeHtml(entry.actor_name)} (${escapeHtml(entry.actor_role)})</td><td>${escapeHtml(entry.action)}</td><td>${escapeHtml(entry.entity)} ${escapeHtml(entry.entity_id)}</td><td>${escapeHtml(entry.details||'—')}</td></tr>`).join('')||'<tr><td colspan="5">No activity has been recorded yet.</td></tr>'}</tbody></table></div><p><a class="button" href="/admin/reports#activity">View full activity report</a></p>${adminBookingManagementMarkup(data)}<h2 class="serif">Bookings</h2><div class="table-wrap"><table><thead><tr><th>Reference</th><th>Customer</th><th>Service and package</th><th>Event date</th><th>Status</th><th>Payment proof and amount received</th><th>Review</th></tr></thead><tbody>${data.bookings.map((b) => { const active = !['Completed','Cancelled','Declined'].includes(b.status); const paidAmountForm = b.payment_status && ['Deposit Paid','Partially Paid','Fully Paid'].includes(b.payment_status) ? `<form data-form="payment-amount" class="inline-action"><input type="hidden" name="booking_id" value="${b.id}"><label>Total actually paid (R)<input name="amount_paid" type="number" min="0.01" step="0.01" value="${b.amount_paid == null ? '' : Number(b.amount_paid).toFixed(2)}" required></label><button class="button button-secondary">Save amount</button></form>` : ''; const review = b.evidence_received && b.payment_status === 'Pending' ? `<label>Total received to date (R)<input type="number" min="0.01" step="0.01" data-payment-amount="${b.id}" required></label><button class="button" type="button" data-payment-review="${b.id}" data-approve="true">Approve payment</button> <button class="button button-secondary" type="button" data-payment-review="${b.id}" data-approve="false">Reject proof</button>` : escapeHtml(b.payment_status || 'Awaiting proof'); return `<tr><td>${escapeHtml(b.reference)}</td><td>${escapeHtml((b as Booking & { customer: string }).customer)}</td><td>${escapeHtml(b.service)}<br>${escapeHtml(b.package_name || '—')}${b.package_price != null ? ` · ${packagePriceLabel({ price: b.package_price, price_from: b.package_price_from || 0 })}` : ''}</td><td>${escapeHtml(b.event_date)} ${escapeHtml(b.start_time)}</td><td>${escapeHtml(b.status)}${active ? `<p><button class="button button-secondary" type="button" data-venue-cancel="${b.id}">Cancel by Escape Villa</button></p>` : ''}</td><td>${b.evidence_received ? `<a href="/api/admin/payment-proof/${b.id}" target="_blank" rel="noopener noreferrer">View proof</a>` : 'Not uploaded'}${paidAmountForm}</td><td>${review}</td></tr>`; }).join('') || '<tr><td colspan="7">No booking records yet.</td></tr>'}</tbody></table></div>`);
  } else {
    if (location.pathname === '/staff/settings') {
      app!.innerHTML = page('Staff settings', 'Manage your staff portal session.', `<p><a class="text-link" href="/staff/dashboard">← Back to your tasks</a></p><h2 class="serif">Account</h2><p class="copy">Signed in as ${escapeHtml(currentUser.name)} (${escapeHtml(currentUser.email)}).</p><button class="button" type="button" data-logout>Log out</button>`);
      return;
    }
    const tasks = await request<Array<{ id: number; name: string; reference: string; service: string; event_date: string; status: string }>>('/api/staff/tasks');
    app!.innerHTML = page(`Welcome, ${escapeHtml(currentUser.name.split(' ')[0])}`, 'Your assigned work.', `<div class="cards">${tasks.map((task) => `<article class="card"><span class="eyebrow">${escapeHtml(task.reference)} · ${escapeHtml(task.event_date)}</span><h2>${escapeHtml(task.name)}</h2><p>${escapeHtml(task.service)} · ${escapeHtml(task.status)}</p><button class="button" data-task="${task.id}">Mark in progress</button></article>`).join('') || '<p class="muted">No tasks have been assigned yet.</p>'}</div>`);
  }
}
async function renderReports(period = 'daily', date = todayLocal()): Promise<void> {
  if (!currentUser || currentUser.role !== 'admin') { location.assign('/admin/login'); return; }
  const report = await request<EscapeReport>(`/api/admin/reports?period=${encodeURIComponent(period)}&date=${encodeURIComponent(date)}`);
  const taskRate = report.summary.totalTasks ? Math.round(report.summary.completedTasks / report.summary.totalTasks * 100) : 0;
  app!.innerHTML = page('Reports', 'Daily, weekly and monthly operational reports.', `<form class="report-filter" data-report-filter><label>Period<select name="period"><option value="daily" ${period==='daily'?'selected':''}>Daily</option><option value="weekly" ${period==='weekly'?'selected':''}>Weekly (Monday to Sunday)</option><option value="monthly" ${period==='monthly'?'selected':''}>Monthly</option></select></label><label>Anchor date<input type="date" name="date" value="${escapeHtml(date)}" required></label><button class="button">Generate report</button></form><p class="muted">Reporting range: ${escapeHtml(report.startDate)} through ${escapeHtml(report.endDateExclusive)} (end date excluded). All results are calculated from saved records.</p><div class="metrics"><div><small>BOOKINGS</small><b>${report.summary.totalBookings}</b></div><div><small>CONFIRMED / COMPLETED BOOKINGS</small><b>${report.summary.confirmed}</b></div><div><small>CANCELLED BOOKINGS</small><b>${report.summary.cancelled}</b></div><div><small>COMPLETED TASKS</small><b>${report.summary.completedTasks}/${report.summary.totalTasks} · ${taskRate}%</b></div><div><small>RECORDED PAYMENTS</small><b>R ${report.summary.paymentAmount.toLocaleString('en-ZA',{minimumFractionDigits:2})}</b></div></div><div class="report-grid"><section class="report-panel"><h2>Bookings by service</h2>${reportTable(report.byService)}</section><section class="report-panel"><h2>Bookings by status</h2>${reportTable(report.byStatus)}</section><section class="report-panel"><h2>Payments by status</h2>${reportTable(report.paymentStatuses)}</section><section class="report-panel"><h2>Tasks by status</h2>${reportTable(report.tasks)}</section></div><section class="report-panel"><div class="report-title"><h2>Booking details</h2><button class="button" type="button" data-export-report>Export CSV</button></div><div class="table-wrap"><table><thead><tr><th>Reference</th><th>Customer</th><th>Service</th><th>Package</th><th>Package price</th><th>Event date</th><th>Venue</th><th>Booking status</th><th>Payment status</th><th>Paid amount</th></tr></thead><tbody>${report.bookings.map((booking)=>`<tr>${['reference','customer','service','package_name','package_price','event_date','venue','status','payment_status','paid_amount'].map((key)=>`<td>${key==='package_price' && booking.package_price != null ? `${Number(booking.package_price_from) ? 'From ' : ''}R ${Number(booking.package_price).toLocaleString('en-ZA')}` : escapeHtml(booking[key]??'—')}</td>`).join('')}</tr>`).join('')||'<tr><td colspan="10">No bookings in this reporting period.</td></tr>'}</tbody></table></div><p class="muted">Package prices are estimates; venue hire, catering, décor rentals and supplier costs are quoted separately unless explicitly included in the agreed package. Payment totals include approved recorded payments only.</p></section><section class="report-panel" id="activity"><div class="report-title"><h2>All recorded activity</h2><button class="button" type="button" data-export-activity>Export activity CSV</button></div><p class="muted">Audit entries are recorded from the time this feature is deployed. The report includes account access, enquiries, bookings, profile updates, staff work and payment decisions.</p><div class="table-wrap"><table><thead><tr><th>When</th><th>Who</th><th>Activity</th><th>Record</th><th>Details</th></tr></thead><tbody>${report.activity.map((entry)=>`<tr><td>${escapeHtml(new Date(entry.created_at).toLocaleString())}</td><td>${escapeHtml(entry.actor_name)} (${escapeHtml(entry.actor_role)})</td><td>${escapeHtml(entry.action)}</td><td>${escapeHtml(entry.entity)} ${escapeHtml(entry.entity_id)}</td><td>${escapeHtml(entry.details||'—')}</td></tr>`).join('')||'<tr><td colspan="5">No activity recorded yet.</td></tr>'}</tbody></table></div></section>`);
  document.querySelector<HTMLFormElement>('[data-report-filter]')?.addEventListener('submit',(event)=>{event.preventDefault();const form=new FormData(event.currentTarget as HTMLFormElement);void renderReports(String(form.get('period')),String(form.get('date'))).catch(showError);});
  document.querySelector<HTMLButtonElement>('[data-export-report]')?.addEventListener('click',()=>exportReport(report));
  document.querySelector<HTMLButtonElement>('[data-export-activity]')?.addEventListener('click',()=>exportActivity(report.activity));
}
function reportTable(rows:Array<{label:string;count:number}>):string{return rows.length?`<table><thead><tr><th>Category</th><th>Count</th></tr></thead><tbody>${rows.map((row)=>`<tr><td>${escapeHtml(row.label)}</td><td>${row.count}</td></tr>`).join('')}</tbody></table>`:'<p class="muted">No records in this period.</p>';}
function exportReport(report:EscapeReport):void{const keys=['reference','customer','service','package_name','package_price','event_date','start_time','venue','status','payment_status','paid_amount'];const quote=(value:unknown):string=>`"${String(value??'').replaceAll('"','""')}"`;const csv=[keys.join(','),...report.bookings.map((row)=>keys.map((key)=>quote(row[key])).join(','))].join('\r\n');const link=document.createElement('a');link.href=URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8'}));link.download=`escape-villa-${report.period}-${report.startDate}.csv`;link.click();URL.revokeObjectURL(link.href);}
function exportActivity(rows:Activity[]):void{const keys:(keyof Activity)[]=['created_at','actor_name','actor_role','action','entity','entity_id','details'];const quote=(value:unknown):string=>`"${String(value??'').replaceAll('\"','\"\"')}"`;const csv=[keys.join(','),...rows.map((row)=>keys.map((key)=>quote(row[key])).join(','))].join('\r\n');const link=document.createElement('a');link.href=URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8'}));link.download='escape-villa-activity.csv';link.click();URL.revokeObjectURL(link.href);}
function showError(error:unknown):void{alert(error instanceof Error?error.message:'Unable to load report.');}

function zar(value: unknown): string { return `R ${Number(value || 0).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`; }
function adminBookingManagementMarkup(data: {
  cancellationRequests: Array<CancellationHistory & { customer: string; customer_email: string; customer_phone?: string; amount_paid: number; booking_status: string; refund_id?: number | null }>;
  rescheduleRequests: Array<{ id:number; requested_json:string; reason:string; status:string; response:string; reference:string; event_date:string; start_time:string; customer:string; customer_email:string }>;
  policy: CancellationPolicy;
}): string {
  const cancellationRows = data.cancellationRequests.map((item) => {
    const refundStatus = item.refund_status || (Number(item.approved_refund_amount) === 0 && item.status === 'Approved' ? 'No refund due' : '—');
    const reviewControls = item.status === 'Pending' ? `<div class="management-actions"><form data-form="cancellation-decision" class="form compact-form"><input type="hidden" name="request_id" value="${item.id}"><input type="hidden" name="decision" value="approve"><label>Approve refund (maximum ${zar(item.amount_paid)})<input name="refund_amount" type="number" min="0" max="${Number(item.amount_paid || 0)}" step="0.01" value="${Number(item.calculated_refund_amount || 0).toFixed(2)}" required></label><button class="button">Approve cancellation</button></form><form data-form="cancellation-decision" class="form compact-form"><input type="hidden" name="request_id" value="${item.id}"><input type="hidden" name="decision" value="reject"><label>Reason for rejection<textarea name="reason" required></textarea></label><button class="button button-secondary">Reject request</button></form></div>` : item.refund_id && item.refund_status !== 'Processed' ? `<form data-form="refund-update" class="form compact-form"><input type="hidden" name="refund_id" value="${item.refund_id}"><label>Refund status<select name="status"><option ${item.refund_status==='Pending'?'selected':''}>Pending</option><option ${item.refund_status==='Failed'?'selected':''}>Failed</option><option>Processed</option></select></label><label>Bank transfer reference<input name="transfer_reference" value="${escapeHtml(item.transfer_reference||'')}"></label><label>Failure reason (if failed)<textarea name="failure_reason">${escapeHtml(item.failure_reason||'')}</textarea></label><label class="check"><input type="checkbox" name="money_sent" value="yes">I confirm the money was sent outside this website</label><button class="button">Save refund status</button></form>` : item.refund_status === 'Processed' ? `<p class="muted">Transfer reference: ${escapeHtml(item.transfer_reference || 'Recorded')}</p>` : '';
    return `<article class="management-card"><div class="management-title"><strong>${escapeHtml(item.customer)}</strong><span class="status-pill">${escapeHtml(item.status)}</span></div><p>${escapeHtml(item.customer_email)}${item.customer_phone ? ` · ${escapeHtml(item.customer_phone)}` : ''}</p><p><strong>${escapeHtml(item.reference)}</strong> · ${escapeHtml(item.event_date)} · ${escapeHtml(item.request_type === 'venue' ? 'Cancelled by Escape Villa' : 'Customer cancellation request')}</p><p>Amount paid: <strong>${zar(item.amount_paid)}</strong> · Policy estimate: <strong>${zar(item.calculated_refund_amount)}</strong> · Approved refund: <strong>${zar(item.approved_refund_amount)}</strong> · Refund status: <strong>${escapeHtml(refundStatus)}</strong></p>${item.reason ? `<p>Request reason: ${escapeHtml(item.reason)}</p>` : ''}${item.rejection_reason ? `<p>Rejection reason: ${escapeHtml(item.rejection_reason)}</p>` : ''}${reviewControls}</article>`;
  }).join('') || '<p class="muted">No cancellation requests yet.</p>';
  const rescheduleRows = data.rescheduleRequests.map((item) => {
    let proposed = 'Requested date unavailable';
    try { const parsed = JSON.parse(item.requested_json) as {event_date:string;start_time:string}; proposed = `${parsed.event_date} ${parsed.start_time}`; } catch { /* Keep the safe fallback. */ }
    const controls = item.status === 'Pending' ? `<div class="management-actions"><form data-form="reschedule-decision" class="form compact-form"><input type="hidden" name="request_id" value="${item.id}"><input type="hidden" name="decision" value="approve"><button class="button">Approve reschedule</button></form><form data-form="reschedule-decision" class="form compact-form"><input type="hidden" name="request_id" value="${item.id}"><input type="hidden" name="decision" value="reject"><label>Reason for rejection<textarea name="reason" required></textarea></label><button class="button button-secondary">Reject request</button></form></div>` : `<p>Decision: ${escapeHtml(item.response || item.status)}</p>`;
    return `<article class="management-card"><div class="management-title"><strong>${escapeHtml(item.customer)}</strong><span class="status-pill">${escapeHtml(item.status)}</span></div><p>${escapeHtml(item.customer_email)} · ${escapeHtml(item.reference)}</p><p>Current: ${escapeHtml(item.event_date)} ${escapeHtml(item.start_time)} · Requested: <strong>${escapeHtml(proposed)}</strong></p>${item.reason ? `<p>Reason: ${escapeHtml(item.reason)}</p>` : ''}${controls}</article>`;
  }).join('') || '<p class="muted">No rescheduling requests yet.</p>';
  return `<section class="management-section"><h2 class="serif">Cancellation policy</h2><p class="muted">Policy estimates use the total verified amount paid to date. The booking deposit is included in that total. An approved refund remains Pending until the transfer is completed outside the website.</p><form data-form="cancellation-policy" class="form policy-form"><label>Days before event for full refund<input name="fullRefundDays" type="number" min="1" max="365" value="${data.policy.fullRefundDays}" required></label><label>Minimum days before event for partial refund<input name="partialRefundDays" type="number" min="0" max="364" value="${data.policy.partialRefundDays}" required></label><label>Partial refund percentage<input name="partialRefundPercent" type="number" min="0" max="100" value="${data.policy.partialRefundPercent}" required></label><button class="button">Save cancellation policy</button><p class="muted">Escape Villa cancellations always qualify for a full refund of the amount actually paid.</p></form></section><section class="management-section"><h2 class="serif">Cancellation requests and refunds</h2>${cancellationRows}</section><section class="management-section"><h2 class="serif">Rescheduling requests</h2><p class="muted">Each booking may be rescheduled once. Approval checks availability again before changing the booking date and time.</p>${rescheduleRows}</section>`;
}

async function route(): Promise<void> {
  const initialRequests: Promise<unknown>[] = [];
  if (!siteDataLoaded) initialRequests.push(request<{ services: Service[]; packages: Package[] }>('/api/public').then((pub) => { services = pub.services; packages = pub.packages; siteDataLoaded = true; }));
  if (!sessionLoaded) initialRequests.push(request<User | null>('/api/me').then((user) => { currentUser = user; sessionLoaded = true; }));
  if (initialRequests.length) await Promise.all(initialRequests);
  const path = location.pathname;
  if (path === '/book' && !currentUser) { history.replaceState({}, '', `/register?next=${encodeURIComponent(location.pathname + location.search)}`); renderAuth('register'); }
  else if (path === '/') renderHome(); else if (path === '/about') renderAbout(); else if (path === '/services') renderServices(); else if (path === '/gallery') renderGallery(); else if (path === '/contact') renderContact(); else if (path === '/book') renderBooking(); else if (path === '/register') renderAuth('register'); else if (path === '/admin/login') renderAuth('admin'); else if (path === '/staff/login') renderAuth('staff'); else if (path === '/admin/setup') renderAuth('setup'); else if (path === '/admin/recover') renderAuth('recover'); else if (path === '/admin/reset-all') renderAdminReset(); else if (path === '/login') renderAuth('login'); else if (path.endsWith('/dashboard')||path==='/admin/reports'||path==='/admin/settings'||path==='/staff/settings') await renderPortal(); else if (path === '/privacy') app!.innerHTML = page('Privacy notice', 'Owner review required before accepting real customer data.', '<p class="copy">Escape Villa uses information submitted in enquiries and bookings, including payment proof files, to respond to requests, manage services and verify payments. Ask the owner for the complete approved privacy notice and retention policy.</p>'); else if (path === '/terms') app!.innerHTML = page('Terms of service', 'Booking and payment terms are confirmed with each request.', '<p class="copy">Cancellation, payment and rescheduling policies require owner approval. Confirm the applicable terms with Escape Villa before paying.</p>'); else renderHome();
  bind();
}
function fileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("Could not read the payment proof file."));
    reader.onerror = () => reject(new Error("Could not read the payment proof file."));
    reader.readAsDataURL(file);
  });
}
function bind(): void {
  document.querySelectorAll<HTMLButtonElement>('[data-password-toggle]').forEach((button) => button.addEventListener('click', () => {
    const input = button.parentElement?.querySelector<HTMLInputElement>('input');
    if (!input) return;
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    button.textContent = show ? 'Hide' : 'Show';
    button.setAttribute('aria-label', `${show ? 'Hide' : 'Show'} password`);
  }));
  document.querySelectorAll<HTMLAnchorElement>('a[href^="/"]').forEach((anchor) => anchor.addEventListener('click', (event) => { if (anchor.target || event.ctrlKey || event.metaKey) return; event.preventDefault(); history.pushState({}, '', anchor.href); void route(); }));
  const bookingForm = document.querySelector<HTMLFormElement>('form[data-form="booking"]');
  const servicePicker = bookingForm?.querySelector<HTMLSelectElement>('select[name="service_id"]');
  const packagePicker = bookingForm?.querySelector<HTMLSelectElement>('select[name="package_id"]');
  const updatePackageSelection = () => {
    const pkg = packages.find((choice) => String(choice.id) === packagePicker?.value);
    const summary = document.querySelector<HTMLElement>('#package-selection');
    if (summary) summary.innerHTML = selectedPackageMarkup(pkg);
    const duration = bookingForm?.querySelector<HTMLInputElement>('input[name="duration_minutes"]');
    if (duration && pkg?.duration_minutes) duration.value = String(pkg.duration_minutes);
  };
  servicePicker?.addEventListener('change', () => {
    const serviceId = Number(servicePicker.value);
    const selectedService = services.find((service) => service.id === serviceId);
    const media = document.querySelector<HTMLElement>('#booking-service-media');
    if (selectedService && media) media.innerHTML = serviceMediaMarkup(selectedService, true);
    const servicePackages = packages.filter((pkg) => pkg.service_id === serviceId);
    if (packagePicker) {
      packagePicker.innerHTML = servicePackages.map((pkg) => `<option value="${pkg.id}">${escapeHtml(pkg.name)} — ${escapeHtml(packagePriceLabel(pkg))}</option>`).join('');
    }
    updatePackageSelection();
  });
  packagePicker?.addEventListener('change', updatePackageSelection);
  const calendar = document.querySelector<HTMLElement>('#booking-calendar');
  const calendarStatus = document.querySelector<HTMLElement>('#booking-calendar-status');
  const selectedDateInput = bookingForm?.querySelector<HTMLInputElement>('input[name="event_date"]');
  const selectedDateLabel = document.querySelector<HTMLElement>('#selected-date-label');
  if (calendar && bookingForm && selectedDateInput) {
    let month = calendar.dataset.month || todayLocal().slice(0, 7);
    let bookedDates = new Set<string>();
    const drawCalendar = () => { calendar.dataset.month = month; calendar.innerHTML = bookingCalendarMarkup(month, bookedDates, selectedDateInput.value); };
    const loadMonth = async (nextMonth: string) => {
      month = nextMonth;
      const requestedMonth = month;
      bookedDates = new Set();
      drawCalendar();
      if (calendarStatus) calendarStatus.textContent = 'Loading booked dates…';
      try {
        const result = await request<{ bookedDates: string[] }>(`/api/booking-dates?month=${encodeURIComponent(requestedMonth)}`);
        if (month !== requestedMonth) return;
        bookedDates = new Set(result.bookedDates);
        drawCalendar();
        if (calendarStatus) calendarStatus.textContent = 'Red dates already have a booking. Another time may still be available.';
      } catch {
        if (calendarStatus) calendarStatus.textContent = 'Could not load booked dates. Availability will be checked when you submit.';
      }
    };
    calendar.addEventListener('click', (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const button = target.closest<HTMLButtonElement>('button');
      if (!button) return;
      if (button.hasAttribute('data-calendar-date')) {
        selectedDateInput.value = button.dataset.calendarDate || '';
        if (selectedDateLabel) selectedDateLabel.textContent = new Date(`${selectedDateInput.value}T12:00:00`).toLocaleDateString('en-ZA', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
        drawCalendar();
      } else if (button.hasAttribute('data-calendar-prev') || button.hasAttribute('data-calendar-next')) {
        const [year, monthNumber] = month.split('-').map(Number);
        const delta = button.hasAttribute('data-calendar-prev') ? -1 : 1;
        const moved = new Date(year, monthNumber - 1 + delta, 1);
        void loadMonth(`${moved.getFullYear()}-${String(moved.getMonth() + 1).padStart(2, '0')}`);
      }
    });
    void loadMonth(month);
  }
  document.querySelectorAll<HTMLFormElement>('form[data-form]').forEach((form) => form.addEventListener('submit', async (event) => {
    event.preventDefault(); const kind = form.dataset.form!; const formData = new FormData(form); const values: Record<string, any> = Object.fromEntries(formData.entries());
    if (kind === 'staff-create' || kind === 'staff-skills') {
      values.skills = formData.getAll('skills').map(String);
      if (!values.skills.length) { alert('Select at least one service for this staff member.'); return; }
    }
    try {
      let result: User | { reference: string } | { ok: boolean; message?: string };
      if (kind === 'contact') result = await request<{ ok: boolean }>('/api/contact', { method: 'POST', body: JSON.stringify(values) });
      else if (kind === 'cancellation-request') {
        if (!window.confirm('Submit a cancellation request for this booking? The booking remains active until Escape Villa reviews it.')) return;
        result = await request<{ ok: boolean; request_id: number }>('/api/customer/cancellation-requests', { method: 'POST', body: JSON.stringify(values) });
      }
      else if (kind === 'reschedule-request') {
        if (!window.confirm('Submit your one rescheduling request? Your booking changes only after Escape Villa approves it.')) return;
        result = await request<{ ok: boolean; request_id: number }>('/api/customer/reschedule-requests', { method: 'POST', body: JSON.stringify(values) });
      }
      else if (kind === 'cancellation-policy') result = await request<{ ok: boolean }>('/api/admin/cancellation-policy', { method: 'PATCH', body: JSON.stringify({ fullRefundDays: Number(values.fullRefundDays), partialRefundDays: Number(values.partialRefundDays), partialRefundPercent: Number(values.partialRefundPercent) }) });
      else if (kind === 'cancellation-decision') {
        if (values.decision === 'approve' && !window.confirm(`Approve cancellation and refund ${zar(values.refund_amount)}? The website will not send the money.`)) return;
        result = await request<{ ok: boolean }>('/api/admin/cancellation-requests', { method: 'PATCH', body: JSON.stringify({ ...values, refund_amount: Number(values.refund_amount) }) });
      }
      else if (kind === 'refund-update') {
        values.money_sent = formData.get('money_sent') === 'yes';
        if (values.status === 'Processed' && !window.confirm('Confirm that Escape Villa has already sent this refund outside the website?')) return;
        result = await request<{ ok: boolean }>('/api/admin/refunds', { method: 'PATCH', body: JSON.stringify(values) });
      }
      else if (kind === 'reschedule-decision') {
        if (values.decision === 'approve' && !window.confirm('Approve this reschedule? The requested time will be checked again first.')) return;
        result = await request<{ ok: boolean }>('/api/admin/reschedule-requests', { method: 'PATCH', body: JSON.stringify(values) });
      }
      else if (kind === 'payment-amount') result = await request<{ ok: boolean }>('/api/admin/payment-amount', { method: 'PATCH', body: JSON.stringify({ booking_id: Number(values.booking_id), amount_paid: Number(values.amount_paid) }) });
      else if (kind === 'booking') {
        if (!values.event_date) { alert('Choose an event date from the calendar.'); return; }
        const proof = formData.get('payment_proof');
        if (!(proof instanceof File) || !proof.size) { alert('Upload your proof of payment to continue.'); return; }
        if (proof.size > 3 * 1024 * 1024) { alert('Payment proof must be no larger than 3 MB.'); return; }
        values.payment_proof = { name: proof.name, type: proof.type, data: await fileAsDataUrl(proof) };
        result = await request<{ reference: string }>('/api/customer/bookings', { method: 'POST', body: JSON.stringify(values) });
      }
      else if (kind === 'reset-all') result = await request<{ ok: boolean; message: string }>('/api/admin/reset-all', { method: 'POST', body: JSON.stringify(values) });
      else if (kind === 'admin-account') {
        if (values.new_password !== values.confirm_password) { alert('The new passwords do not match.'); return; }
        result = await request<User>('/api/admin/account', { method: 'PATCH', body: JSON.stringify(values) });
      }
      else if (kind === 'staff-create') result = await request<User>('/api/admin/staff', { method: 'POST', body: JSON.stringify(values) });
      else if (kind === 'staff-skills') result = await request<{ ok: boolean }>('/api/admin/staff', { method: 'PATCH', body: JSON.stringify({ staff_user_id: Number(form.dataset.staffUserId), skills: values.skills }) });
      else if (kind === 'profile') result = await request<User>('/api/customer/profile', { method: 'PATCH', body: JSON.stringify(values) });
      else if (kind === 'password') {
        if (values.new_password !== values.confirm_password) { alert('The new passwords do not match.'); return; }
        result = await request<User>('/api/customer/profile', { method: 'PATCH', body: JSON.stringify({ current_password: values.current_password, new_password: values.new_password, name: currentUser?.name, email: currentUser?.email, phone: currentUser?.phone }) });
      }
      else if (kind === 'register') {
        if (values.password !== values.confirm_password) { alert('Your passwords do not match.'); return; }
        result = await request<{ ok: boolean }>('/api/register', { method: 'POST', body: JSON.stringify({ ...values }) });
      }
      else if (kind === 'recover') {
        if (values.password !== values.confirm_password) { alert('The new passwords do not match.'); return; }
        result = await request<User>('/api/admin/recover', { method: 'POST', body: JSON.stringify(values) });
      }
      else if (kind === 'setup') result = await request<User>('/api/admin/setup', { method: 'POST', body: JSON.stringify(values) });
      else result = await request<User>(`/api/${kind === 'admin' ? 'admin/' : kind === 'staff' ? 'staff/' : ''}login`, { method: 'POST', body: JSON.stringify(values) });
      if (kind === 'contact') { form.reset(); alert('Your enquiry has been received.'); }
      else if (kind === 'cancellation-request') { alert('Your cancellation request was submitted. The booking remains unchanged while it is reviewed.'); await route(); }
      else if (kind === 'reschedule-request') { alert('Your rescheduling request was submitted. Your current date and time remain until it is approved.'); await route(); }
      else if (kind === 'cancellation-policy') { alert('Cancellation policy saved.'); await route(); }
      else if (kind === 'cancellation-decision') { alert(values.decision === 'approve' ? 'Cancellation approved. Any refund is Pending until Escape Villa sends it outside the website.' : 'Cancellation request rejected.'); await route(); }
      else if (kind === 'refund-update') { alert('Refund status updated.'); await route(); }
      else if (kind === 'reschedule-decision') { alert(values.decision === 'approve' ? 'Reschedule approved and booking updated.' : 'Rescheduling request rejected.'); await route(); }
      else if (kind === 'payment-amount') { alert('Total amount actually paid was saved.'); await route(); }
      else if (kind === 'register') { alert('Your account has been created. Please log in with your email and password.'); const requested = new URLSearchParams(location.search).get('next'); const safeNext = requested && requested.startsWith('/') && !requested.startsWith('//') ? `?next=${encodeURIComponent(requested)}` : ''; history.pushState({}, '', `/login${safeNext}`); await route(); }
      else if (kind === 'booking') { alert(`Service booking submitted: ${(result as { reference: string }).reference}. The team will review your booking and payment proof.`); history.pushState({}, '', '/customer/dashboard'); await route(); }
      else if (kind === 'reset-all') { currentUser = null; alert((result as { message?: string }).message || 'Reset complete.'); history.pushState({}, '', '/admin/setup'); await route(); }
      else if (kind === 'admin-account') { currentUser = result as User; alert('Administrator login details updated. Use the new email and password next time you log in.'); await route(); }
      else if (kind === 'staff-create') { alert('Staff account created with the selected services for booking allocation.'); await route(); }
      else if (kind === 'staff-skills') { alert('Staff services updated. New approved bookings will use these selections for allocation.'); await route(); }
      else if (kind === 'profile') { currentUser = result as User; alert('Your account details have been saved.'); await route(); }
      else if (kind === 'password') { currentUser = result as User; alert('Your password has been updated.'); await route(); }
      else { currentUser = result as User; const requested = new URLSearchParams(location.search).get('next'); const safeNext = requested && requested.startsWith('/') && !requested.startsWith('//') && currentUser.role === 'customer' ? requested : `/${currentUser.role}/dashboard`; history.pushState({}, '', safeNext); await route(); }
    } catch (error) { alert(error instanceof Error ? error.message : 'Please try again.'); }
  }));
  document.querySelectorAll<HTMLButtonElement>('[data-task]').forEach((button) => button.addEventListener('click', async () => { try { await request('/api/staff/tasks', { method: 'PATCH', body: JSON.stringify({ task_id: Number(button.dataset.task), status: 'In Progress' }) }); await route(); } catch (error) { alert(error instanceof Error ? error.message : 'Could not update task.'); } }));
  document.querySelectorAll<HTMLButtonElement>('[data-payment-review]').forEach((button) => button.addEventListener('click', async () => {
    const approve = button.dataset.approve === 'true';
    if (!approve && !window.confirm('Reject this payment proof? The customer will see that it needs correction.')) return;
    const amountInput = approve ? document.querySelector<HTMLInputElement>(`[data-payment-amount="${button.dataset.paymentReview}"]`) : null;
    const amountReceived = amountInput ? Number(amountInput.value) : 0;
    if (approve && (!amountInput?.value || !Number.isFinite(amountReceived) || amountReceived <= 0 || Math.round(amountReceived * 100) !== amountReceived * 100)) { alert('Enter the total amount actually received so far before approving the payment.'); return; }
    button.disabled = true;
    try {
      const result = await request<{ emailSent: boolean; emailMessage?: string; staffAssigned: boolean }>('/api/admin/payment-review', {
        method: 'POST',
        body: JSON.stringify({ booking_id: Number(button.dataset.paymentReview), approve, amount_received: amountReceived }),
      });
      if (approve) {
        const assignmentMessage = result.staffAssigned
          ? 'A staff member was assigned.'
          : 'No available qualified staff member was found; please follow up with the team.';
        const emailMessage = result.emailSent
          ? 'The customer approval email was sent.'
          : `The customer email was not sent: ${result.emailMessage || 'email provider is not configured.'}`;
        alert(`Booking approved. ${assignmentMessage} ${emailMessage}`);
      } else {
        alert('Payment proof rejected.');
      }
      await route();
    } catch (error) {
      button.disabled = false;
      alert(error instanceof Error ? error.message : 'Could not review this booking.');
    }
  }));
  document.querySelectorAll<HTMLButtonElement>('[data-venue-cancel]').forEach((button) => button.addEventListener('click', async () => {
    if (!window.confirm('Cancel this booking on behalf of Escape Villa? The customer will qualify for a full refund of the total amount recorded as paid. Assigned staff will be released.')) return;
    const reason = window.prompt('Reason for the Escape Villa cancellation:', 'Escape Villa cancelled this booking.') || '';
    button.disabled = true;
    try { await request('/api/admin/venue-cancellations', { method: 'POST', body: JSON.stringify({ booking_id: Number(button.dataset.venueCancel), reason }) }); alert('Booking cancelled. Any refund is Pending until sent outside the website.'); await route(); }
    catch (error) { button.disabled = false; alert(error instanceof Error ? error.message : 'Could not cancel the booking.'); }
  }));
  document.querySelectorAll<HTMLButtonElement>('[data-logout]').forEach((button) => button.addEventListener('click', async () => { try { await request('/api/logout', { method: 'POST' }); currentUser = null; history.pushState({}, '', '/'); await route(); } catch (error) { alert(error instanceof Error ? error.message : 'Could not sign out.'); } }));
}
window.addEventListener('popstate', () => { void route(); });
void route().catch((error: unknown) => { app!.innerHTML = `<main class="container"><h1>Escape Villa could not load</h1><p>${escapeHtml(error instanceof Error ? error.message : 'Start the server with npm start.')}</p></main>`; });
