// SPIKE (phase 1 step 6): fixtures for the Markdown + KaTeX streaming spike.
// Delete at step 7 together with the rest of src/spike/markdown, or turn the winner into
// the real component.

const FENCE = '```';
const TICK = '`';

/** A realistic Teacher answer: Vietnamese + English, inline/block math, code, list, table. */
export const TEACHER_ANSWER = String.raw`## Đạo hàm của hàm số (Derivative)

Chào bạn! Hôm nay ta học **đạo hàm**. *Derivative* đo tốc độ thay đổi tức thời: nếu $f(x) = x^2$ thì $f'(x) = 2x$. Đừng lo, một vé giá $5 hoặc $10 không phải là công thức.

### Định nghĩa

Đạo hàm của $f$ tại điểm $x$ là giới hạn của tỉ số gia, tức là "the limit of the difference quotient":

$$
f'(x) = \lim_{h \to 0} \frac{f(x+h) - f(x)}{h}
$$

Với $f(x) = x^2$ ta có $\frac{(x+h)^2 - x^2}{h} = 2x + h$, nên $f'(x) = 2x$.

### Các quy tắc thường dùng

1. Quy tắc luỹ thừa: $(x^n)' = n x^{n-1}$
2. Quy tắc tổng: $(f+g)' = f' + g'$
3. Quy tắc tích: $(fg)' = f'g + fg'$
4. Quy tắc chuỗi (*chain rule*): $\frac{d}{dx} f(g(x)) = f'(g(x))\,g'(x)$

Một ví dụ nhiều dòng, dùng môi trường ${TICK}aligned${TICK}:

$$
\begin{aligned}
\int_0^1 x^2\,dx &= \left[\frac{x^3}{3}\right]_0^1 \\
&= \frac{1}{3} - 0 = \frac{1}{3}
\end{aligned}
$$

> Mẹo: luôn kiểm tra đơn vị. Nếu $s(t)$ là quãng đường (m) thì $s'(t)$ có đơn vị m/s.

### Kiểm tra bằng code

Ta có thể xấp xỉ đạo hàm bằng sai phân hữu hạn:

${FENCE}python
def derivative(f, x, h=1e-6):
    # central difference, error is O(h^2)
    return (f(x + h) - f(x - h)) / (2 * h)

print(derivative(lambda x: x**2, 3))  # ~ 6.0
${FENCE}

### Bảng tóm tắt

| Hàm $f(x)$ | Đạo hàm $f'(x)$ | Ghi chú |
| --- | :---: | --- |
| $x^2$ | $2x$ | luỹ thừa |
| $\sin x$ | $\cos x$ | lượng giác |
| $e^x$ | $e^x$ | bằng chính nó |

Bây giờ bạn thử tính đạo hàm của $g(x) = 3x^3 - 2x$ nhé. Bạn nghĩ kết quả là gì?
`;

/** Untrusted model output: every payload tries to run script or leak via markup or TeX. */
export const HOSTILE = String.raw`# Hostile output

Plain <script>window.__pwned = 'script'</script> text.

<img src=x onerror="window.__pwned='img-onerror'">

<iframe srcdoc="<script>parent.__pwned='iframe'</script>"></iframe>

<svg onload="window.__pwned='svg'"></svg>

<a href="javascript:window.__pwned='html-a'">html link</a>

[md link](javascript:window.__pwned='md-link') and [obfuscated](  jAvA	sCrIpT:window.__pwned='obf') and [data](data:text/html,<script>parent.__pwned=1</script>)

![md image](javascript:window.__pwned='md-img') ![ok](https://example.com/x.png "t")

&lt;script&gt;window.__pwned='entity'&lt;/script&gt; &#60;img src=x onerror=window.__pwned=1&#62;

| a | b |
| --- | --- |
| <script>window.__pwned='cell'</script> | <img src=x onerror="window.__pwned='cell-img'"> |

- item <b onmouseover="window.__pwned='li'">bold</b>

${FENCE}html
<script>window.__pwned='code'</script>
${FENCE}

Math: $\href{javascript:window.__pwned='tex-href'}{click}$ and $\url{javascript:window.__pwned='tex-url'}$
and $\htmlClass{evil}{x}$ and $\htmlId{evil-id}{x}$ and $\includegraphics{https://example.com/x.png}$
and $\def\a{\a\a}\a$ and $\rule{99999em}{99999em}$ and $\Huge\Huge\Huge x$.

$$
\href{javascript:window.__pwned='tex-block'}{x} \htmlData{k=v}{y} \def\b{\b\b\b}\b
$$

<!-- comment --> <style>body{display:none}</style> done.
`;

/** Small deterministic PRNG so every run and browser streams identical chunks. */
function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Split into token-sized pieces (1-8 UTF-16 units, mean about 4), like a model's SSE deltas. */
export function chunkText(text: string, seed = 1): string[] {
  const rand = mulberry32(seed);
  const chunks: string[] = [];
  let i = 0;
  while (i < text.length) {
    const size = 1 + Math.floor(rand() * 8);
    chunks.push(text.slice(i, i + size));
    i += size;
  }
  return chunks;
}
