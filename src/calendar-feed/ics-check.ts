/**
 * What RFC 5545 asks of a calendar's shape, checked without a parser of its
 * own: CRLF lines of at most 75 octets (folded behind a space), no CR or other
 * control character but the line ends (a tab aside), BEGIN and END
 * nested and closed, each VEVENT with its UID, DTSTAMP and DTSTART, no UID
 * twice, and every TZID a VTIMEZONE of the file defines. The tests and the
 * adapter probe run it over the feed as written; it answers the problems,
 * none for a well-formed calendar.
 */
export function icsProblems(ics: string): string[] {
  const problems: string[] = [];
  if (!ics.endsWith('\r\n')) problems.push('the last line has no CRLF');
  if (/(^|[^\r])\n/.test(ics)) problems.push('a line ends in LF alone');
  if (/\r(?!\n)/.test(ics)) problems.push('a CR stands alone');
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(ics)) problems.push('a control character is in the text');
  const physical = ics.split('\r\n').slice(0, -1);
  physical.forEach((line, index) => {
    if (Buffer.byteLength(line, 'utf8') > 75) problems.push(`line ${index + 1} is over 75 octets`);
  });
  const lines = ics.replace(/\r\n[ \t]/g, '').split('\r\n').filter((line) => line !== '');
  const open: string[] = [];
  const zones = new Set<string>();
  const uids = new Set<string>();
  let event: Set<string> | null = null;
  for (const line of lines) {
    const name = line.split(/[;:]/, 1)[0]!;
    if (name === 'BEGIN') {
      const block = line.slice('BEGIN:'.length);
      open.push(block);
      if (block === 'VEVENT') event = new Set();
    } else if (name === 'END') {
      const block = line.slice('END:'.length);
      if (open.pop() !== block) problems.push(`END:${block} closes no BEGIN:${block}`);
      if (block === 'VEVENT' && event) {
        for (const required of ['UID', 'DTSTAMP', 'DTSTART']) if (!event.has(required)) problems.push(`a VEVENT has no ${required}`);
        event = null;
      }
    } else {
      if (event) event.add(name);
      if (name === 'TZID' && open[open.length - 1] === 'VTIMEZONE') zones.add(line.slice('TZID:'.length));
      if (name === 'UID') {
        if (uids.has(line)) problems.push(`${line} twice`);
        uids.add(line);
      }
      const zone = /;TZID=([^:;]+)/.exec(line)?.[1];
      if (zone && open[open.length - 1] !== 'VTIMEZONE' && !zones.has(zone)) problems.push(`TZID ${zone} is defined by no VTIMEZONE before it`);
    }
  }
  if (open.length > 0) problems.push(`${open.join(', ')} left open`);
  if (lines[0] !== 'BEGIN:VCALENDAR' || lines[lines.length - 1] !== 'END:VCALENDAR') problems.push('the file is not one VCALENDAR');
  return problems;
}
