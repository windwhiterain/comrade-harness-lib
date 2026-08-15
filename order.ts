// 会话内消息的顺序键（order key）：session_messages 的 ord 列取代旧的 pos 整数列。
// ord 是字典序字符串：追加 = 取当前最大键的后继（appendKey，摊还 O(1)）；中间插入 = 在前后邻居之间
// 生成一个键（midKey，fractional indexing，O(键长)）；键空间耗尽（下界是上界的前缀且余尾全 0，无间隙）
// 时 midKey 返回 null，调用方整表重排（rebalance，O(n)，罕见）后重试。
// 排序：SQLite 按 BINARY collation 排序（字节序），与这里的字符串比较一致。

const DIGITS = "0123456789abcdefghijklmnopqrstuvwxyz"; // 36 进制：'0' 最小，'z' 最大
const v = (c: string) => DIGITS.indexOf(c);

/** 追加键：返回严格大于 prev 的一个新键（prev 为 "" = 空表，取 "m" 留足余量）。 */
export function appendKey(prev: string): string {
  if (!prev) return "m";
  const chars = prev.split("");
  for (let i = chars.length - 1; i >= 0; i--) {
    const idx = v(chars[i]);
    if (idx < DIGITS.length - 1) {
      chars[i] = DIGITS[idx + 1];
      return chars.slice(0, i + 1).join("");
    }
  }
  return prev + "m"; // 全 'z'：扩展一位
}

/**
 * 中间键：返回 a < k < b 的键；a 为 "" = -∞，b 为 "" = +∞（此时 = 末尾插入，取 appendKey(a)）。
 * 无间隙（a 是 b 的前缀且 b 余尾全 '0'）时返回 null——调用方应整表重排后重试。
 * 字符游走规则：逐位比较；下/上界此位差值 ≥2 取中位收尾；相邻/相等沿用下界字符继续；
 * 下界耗尽后附加小于上界此位的字符（留余量）；上界此位是 '0' 只能继续扩展；上界耗尽且
 * 已分叉（out 早于上界）任取一字符（'m' 留余量）——分叉保证 out 的任何扩展都小于上界。
 */
export function midKey(a: string, b: string): string | null {
  if (b === "") return appendKey(a);
  if (a && b && a >= b) return null; // 调用方保证 a < b；防御
  let out = "";
  let diverged = false; // 是否已与上界分叉（在某位置下界字符 < 上界字符，且非 '0' 扩展）——分叉后 out < b，任意扩展都 < b
  let i = 0;
  while (true) {
    const ad = i < a.length ? v(a[i]) : -1;
    const bd = i < b.length ? v(b[i]) : DIGITS.length;
    if (ad >= 0 && bd < DIGITS.length) {
      if (bd - ad >= 2) return out + DIGITS[Math.floor((ad + bd) / 2)];
      if (bd - ad === 1) diverged = true;
      out += DIGITS[ad]; // 相等或相邻：沿用下界字符，继续下一位
      i++;
      continue;
    }
    if (ad < 0) {
      // 下界已耗尽（out == a）
      if (diverged) return out + "m"; // 已分叉：out < b，任意扩展都 < b（且 > a）
      // 未分叉（a 是 b 的前缀）：必须在 b 此位之下取字符
      if (bd === DIGITS.length) return null; // b 已耗尽 → a ≥ b（防御/无间隙）
      if (bd >= 2) return out + DIGITS[Math.floor((bd - 1) / 2)];
      if (bd === 1) return out + DIGITS[0];
      // bd === 0：上界此位是 '0'，只能先扩展再找
      out += DIGITS[0];
      i++;
      continue;
    }
    // 上界已耗尽而下界还有字符：能到这一步必有更早的相邻分叉（否则 a ≥ b），out < b；
    // 沿用 a 的字符继续推进，直到 a 耗尽后由"已分叉 → 任意扩展"收尾（直接取后继会撞上界，
    // 例子：a="0004200z" b="0004201"——succ(0)+1 会等于 b）
    out += DIGITS[ad];
    i++;
    continue;
  }
}

/** 是否有插入间隙（a < b 之间能否生成键）：a 是 b 的前缀且 b 余尾全 0 = 无间隙。 */
export function hasGap(a: string, b: string): boolean {
  if (!a || !b) return true; // ±∞ 总有间隙
  if (!b.startsWith(a)) return true;
  return !/^0+$/.test(b.slice(a.length));
}

/** 整表重排：把 keys（按当前顺序）重排成等间隔键（10 位十进制，间隔 1024），留足插入余量。 */
export function rebalanceKeys(keys: string[]): string[] {
  return keys.map((_, i) => String((i + 1) * 1024).padStart(10, "0"));
}