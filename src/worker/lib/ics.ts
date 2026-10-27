/** 予定の ICS（iCalendar）ファイル。ゲストが自分のカレンダーに取り込むため */

const stamp = (iso: string) => iso.replace(/[-:]/g, '').replace(/\.\d{3}/, '');

/** ICS の文字列に使えない文字をエスケープする */
const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/;/g, '\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');

export interface IcsEvent {
  uid: string;
  start: string;
  end: string;
  summary: string;
  description: string;
  location: string;
  url: string;
  cancelled: boolean;
  sequence: number;
}

export function buildIcs(ev: IcsEvent): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Aiteru//Scheduling//JA',
    'CALSCALE:GREGORIAN',
    `METHOD:${ev.cancelled ? 'CANCEL' : 'PUBLISH'}`,
    'BEGIN:VEVENT',
    `UID:${ev.uid}`,
    `DTSTAMP:${stamp(new Date().toISOString())}`,
    `DTSTART:${stamp(ev.start)}`,
    `DTEND:${stamp(ev.end)}`,
    `SUMMARY:${esc(ev.summary)}`,
    `DESCRIPTION:${esc(ev.description)}`,
    ...(ev.location ? [`LOCATION:${esc(ev.location)}`] : []),
    `URL:${ev.url}`,
    `STATUS:${ev.cancelled ? 'CANCELLED' : 'CONFIRMED'}`,
    `SEQUENCE:${ev.sequence}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return lines.join('\r\n') + '\r\n';
}
