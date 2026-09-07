export const MAX_STATE_BYTES = 5 * 1024 * 1024;
export function validateState(data) {
  const object = value => value && typeof value === 'object' && !Array.isArray(value);
  const text = (value, max) => {
    if (typeof value !== 'string' || [...value].length > max) throw Error('입력 길이나 형식을 확인해 주세요.');
    return value;
  };
  if (!object(data) || data.version !== 1 || !object(data.profile) || !object(data.records) || !object(data.reflections)) throw Error('지원하지 않는 기록 파일이에요.');
  const clean = {version: 1, profile: {}, records: {}, reflections: {}};
  for (const [key, max] of Object.entries({className:30,studentNumber:10,studentName:30,place:100,precaution:150})) clean.profile[key] = text(data.profile[key] ?? '', max);
  if (Object.keys(data.records).length > 1500 || Object.keys(data.reflections).length > 240) throw Error('기록 수가 너무 많아요.');
  const phases = ['new','crescent','first','waxing','full','waning','last','old','hidden'];
  for (const [day, r] of Object.entries(data.records)) {
    const date = new Date(day + 'T12:00:00Z');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(+date) || date.toISOString().slice(0,10) !== day || day < '1900-01-01' || day > '2100-12-31' || !object(r)) throw Error('관찰 날짜를 확인해 주세요.');
    if (r.phase !== null && !phases.includes(r.phase)) throw Error('달 모양을 확인해 주세요.');
    if (typeof r.time !== 'string' || (r.time && !/^([01]\d|2[0-3]):[0-5]\d$/.test(r.time))) throw Error('관찰 시각을 확인해 주세요.');
    if (r.photo !== null) {
      if (typeof r.photo !== 'string' || r.photo.length >= 1500000) throw Error('사진 용량이 너무 커요.');
      const match = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(r.photo);
      if (!match) throw Error('지원하지 않는 사진 형식이에요.');
      let raw; try { raw = atob(match[2]); } catch { throw Error('사진 파일을 확인해 주세요.'); }
      const valid = match[1] === 'jpeg' ? raw.startsWith('\xff\xd8\xff') : match[1] === 'png' ? raw.startsWith('\x89PNG\r\n\x1a\n') : raw.startsWith('RIFF') && raw.slice(8,12) === 'WEBP';
      if (!valid) throw Error('사진 파일을 확인해 주세요.');
    }
    if (!r.phase && !r.photo) throw Error('달 모양이나 사진이 필요해요.');
    clean.records[day] = {phase:r.phase,photo:r.photo,time:r.time,note:text(r.note,100)};
  }
  for (const [month, value] of Object.entries(data.reflections)) {
    if (!/^(19\d{2}|20\d{2}|2100)-(0[1-9]|1[0-2])$/.test(month)) throw Error('관찰 월을 확인해 주세요.');
    clean.reflections[month] = text(value,2000);
  }
  // PostgreSQL jsonb includes spaces. Leave room for its representation overhead.
  if (new TextEncoder().encode(JSON.stringify(clean)).length > MAX_STATE_BYTES - 100000) throw Error('학생별 저장 용량(5MB)을 초과했어요. 기록을 내보낸 뒤 오래된 사진을 정리해 주세요.');
  return clean;
}
