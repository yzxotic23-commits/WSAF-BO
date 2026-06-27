/** True when FeedFlow UI runs inside AMS (iframe). */
export function isAmsEmbed() {
  try {
    if (window.self !== window.top) return true;
    const p = new URLSearchParams(window.location.search);
    return p.get('embed') === 'ams';
  } catch {
    return false;
  }
}
