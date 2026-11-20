package reflipped.shell.content;

/**
 * The "REFLIPPED" line under the title-screen logo, drawn from the logo's own letters: a port of
 * tools/make_logo.py (which embedded builds run at build time) for import builds, which draw it on the phone from the
 * player's own bundle.zip ({@link BundleLogo}). Every letter of REFLIPPED occurs in the logo's lettering, so the glyph
 * shapes are cut out of the logo, scaled down and restyled flat with the logo's white rim; the long lightning-bolt
 * tail is faded out so it doesn't run through the new line.
 *
 * Pure Java on non-premultiplied ARGB pixels (no Android classes), so a desktop test runs it. The integer arithmetic
 * follows Pillow's (luma, multiply, Lanczos and bicubic resampling with Pillow's choice of pass order, alpha
 * compositing): on the game's logo the result is pixel for pixel make_logo.py's (checked against Pillow 13).
 */
public final class LogoStamp {
    public static final int WIDTH = 1015, HEIGHT = 683;

    /** Boxes (x0, y0, x1, y1) around single letters of the logo's lettering. */
    private static int[] glyph(char c) {
        switch (c) {
            case 'R': return new int[] {426, 296, 499, 415};
            case 'D': return new int[] {559, 296, 634, 415};
            case 'F': return new int[] {258, 412, 324, 510};
            case 'L': return new int[] {326, 412, 381, 510};
            case 'I': return new int[] {381, 412, 407, 510};
            case 'P': return new int[] {413, 412, 482, 510};
            case 'E': return new int[] {555, 412, 624, 510};
            default: throw new IllegalArgumentException(String.valueOf(c));
        }
    }

    private static final String WORD = "REFLIPPED";
    private static final double SCALE = 0.66;  // glyph size relative to the logo's letters
    private static final int GAP = 9;           // px between letters, at final size
    private static final int TOP_Y = 556;       // top of the letters, close under the logo
    private static final int CENTER_X = 460;    // horizontal centre of the logo art
    private static final int PAD = 14;          // transparent margin around the word for its keylines
    private static final int ACCENT = 0xFF961E; // "RE": the orange of the game's Home tab and energy bar
    private static final int INK = 0x0E0618;    // "FLIPPED" and the outline: the logo's black keyline
    private static final int WHITE = 0xFFFFFF;  // the logo's white rim
    private static final int BOLT_X0 = 540, BOLT_X1 = 720;  // columns holding the bolt's tail
    private static final int BOLT_FADE_START = 470, BOLT_FADE_END = 560;

    private LogoStamp() {
    }

    /** One 8-bit channel. */
    static final class Gray {
        final int w, h;
        final int[] v;

        Gray(int w, int h) {
            this.w = w;
            this.h = h;
            this.v = new int[w * h];
        }

        int get(int x, int y) {
            return v[y * w + x];
        }
    }

    /**
     * The logo with the REFLIPPED line, as new pixels, or null if `argb` isn't WIDTH x HEIGHT (then it isn't the
     * expected logo).
     */
    public static int[] stamp(int[] argb, int width, int height) {
        if (width != WIDTH || height != HEIGHT || argb.length != width * height) return null;
        int[] out = trimBolt(argb, width, height);
        Word word = wordImage(argb, width);
        alphaComposite(out, width, height, word.argb, word.w, word.h, CENTER_X - word.w / 2, TOP_Y - PAD);
        return out;
    }

    /** Where the stamp may change pixels: the word's area and the bolt's faded tail, as (x0, y0, x1, y1) boxes. */
    static int[][] changedAreas(int[] argb, int width) {
        Word word = wordImage(argb, width);
        int x0 = CENTER_X - word.w / 2, y0 = TOP_Y - PAD;
        return new int[][] {{x0, y0, x0 + word.w, y0 + word.h}, {BOLT_X0, BOLT_FADE_START, BOLT_X1, HEIGHT}};
    }

    // ---------------------------------------------------------------- the steps of make_logo.py

    /** Fades out the lightning bolt's long tail (alpha times a vertical ramp, then zero below it). */
    static int[] trimBolt(int[] argb, int width, int height) {
        Gray fade = new Gray(width, height);
        java.util.Arrays.fill(fade.v, 255);
        // Image.linear_gradient("L").rotate(180): every row y holds 255 - y; then resized with Pillow's default filter
        Gray gradient = new Gray(256, 256);
        for (int y = 0; y < 256; y++) for (int x = 0; x < 256; x++) gradient.v[y * 256 + x] = 255 - y;
        Gray ramp = resize(gradient, BOLT_X1 - BOLT_X0, BOLT_FADE_END - BOLT_FADE_START, BICUBIC);
        paste(fade, ramp, BOLT_X0, BOLT_FADE_START);
        for (int y = BOLT_FADE_END; y < height; y++) {
            for (int x = BOLT_X0; x < BOLT_X1; x++) fade.v[y * width + x] = 0;
        }
        int[] out = new int[argb.length];
        for (int i = 0; i < argb.length; i++) {
            int a = mul(argb[i] >>> 24, fade.v[i]);
            out[i] = (a << 24) | (argb[i] & 0xFFFFFF);
        }
        return out;
    }

    /** Coverage (0..255) of the letters' ink: dark or blue pixels, not the white keyline or glow. */
    static Gray glyphCoverage(int[] argb, int width) {
        int[] ramp = new int[256];
        for (int v = 0; v < 256; v++) ramp[v] = Math.max(0, Math.min(255, (int) ((150 - v) * 255 / 50.0)));
        Gray cov = new Gray(width, argb.length / width);
        for (int i = 0; i < argb.length; i++) {
            int p = argb[i];
            int luma = (((p >> 16) & 255) * 19595 + ((p >> 8) & 255) * 38470 + (p & 255) * 7471 + 0x8000) >> 16;
            cov.v[i] = mul(ramp[luma], p >>> 24);
        }
        return cov;
    }

    private static final class Mask {
        final Gray mask;
        final int split;

        Mask(Gray mask, int split) {
            this.mask = mask;
            this.split = split;
        }
    }

    static Mask wordMask(int[] argb, int width) {
        Gray cov = glyphCoverage(argb, width);
        Gray[] parts = new Gray[WORD.length()];
        int total = 0, height = 0;
        for (int i = 0; i < parts.length; i++) {
            int[] box = glyph(WORD.charAt(i));
            Gray g = crop(cov, box[0], box[1], box[2], box[3]);
            int[] bbox = bbox(g, 40);
            if (bbox != null) g = crop(g, bbox[0], bbox[1], bbox[2], bbox[3]);
            // Python's round() rounds halves to even, like Math.rint
            g = resize(g, (int) Math.rint(g.w * SCALE), (int) Math.rint(g.h * SCALE), LANCZOS);
            parts[i] = g;
            total += g.w;
            height = Math.max(height, g.h);
        }
        Gray mask = new Gray(total + GAP * (parts.length - 1), height);
        int x = 0, split = 0;
        for (int i = 0; i < parts.length; i++) {  // tops aligned, like the logo's lettering
            paste(mask, parts[i], x, 0);
            x += parts[i].w + GAP;
            if (i == 1) split = x - GAP / 2;  // between "RE" and "FLIPPED"
        }
        return new Mask(mask, split);
    }

    private static final class Word {
        final int[] argb;
        final int w, h;

        Word(int[] argb, int w, int h) {
            this.argb = argb;
            this.w = w;
            this.h = h;
        }
    }

    /** REFLIPPED styled: "RE" orange, "FLIPPED" black, a dark outline and the logo's white rim around both. */
    static Word wordImage(int[] argb, int width) {
        Mask m = wordMask(argb, width);
        int w = m.mask.w + 2 * PAD, h = m.mask.h + 2 * PAD;
        Gray letters = new Gray(w, h);
        paste(letters, m.mask, PAD, PAD);
        int[] fill = new int[w * h];
        int splitX = PAD + m.split;
        for (int y = 0; y < h; y++) {
            for (int x = 0; x < w; x++) {
                int a = letters.v[y * w + x];
                // the two halves never overlap, so compositing each onto the empty image just copies it
                fill[y * w + x] = (a << 24) | (x < splitX ? ACCENT : INK);
            }
        }
        int[] txt = solid(WHITE, maxFilter(letters, 11));
        alphaComposite(txt, w, h, solid(INK, maxFilter(letters, 5)), w, h, 0, 0);
        alphaComposite(txt, w, h, fill, w, h, 0, 0);
        return new Word(txt, w, h);
    }

    // ---------------------------------------------------------------- image operations (Pillow's arithmetic)

    /** ImageChops.multiply on one channel. */
    static int mul(int a, int b) {
        return a * b / 255;
    }

    static Gray crop(Gray g, int x0, int y0, int x1, int y1) {
        Gray out = new Gray(x1 - x0, y1 - y0);
        for (int y = y0; y < y1; y++) {
            for (int x = x0; x < x1; x++) {
                boolean inside = x >= 0 && y >= 0 && x < g.w && y < g.h;
                out.v[(y - y0) * out.w + (x - x0)] = inside ? g.v[y * g.w + x] : 0;
            }
        }
        return out;
    }

    /** The box (x0, y0, x1, y1) around the pixels above `threshold`, or null if there are none. */
    static int[] bbox(Gray g, int threshold) {
        int x0 = g.w, y0 = g.h, x1 = -1, y1 = -1;
        for (int y = 0; y < g.h; y++) {
            for (int x = 0; x < g.w; x++) {
                if (g.v[y * g.w + x] > threshold) {
                    x0 = Math.min(x0, x);
                    y0 = Math.min(y0, y);
                    x1 = Math.max(x1, x);
                    y1 = Math.max(y1, y);
                }
            }
        }
        return x1 < 0 ? null : new int[] {x0, y0, x1 + 1, y1 + 1};
    }

    /** Copies `src` into `dst` at (x, y), clipped to `dst`. */
    static void paste(Gray dst, Gray src, int x, int y) {
        for (int sy = 0; sy < src.h; sy++) {
            int dy = y + sy;
            if (dy < 0 || dy >= dst.h) continue;
            for (int sx = 0; sx < src.w; sx++) {
                int dx = x + sx;
                if (dx >= 0 && dx < dst.w) dst.v[dy * dst.w + dx] = src.v[sy * src.w + sx];
            }
        }
    }

    /** ImageFilter.MaxFilter(size): the largest value in a size x size square (separable; edges clamp). */
    static Gray maxFilter(Gray g, int size) {
        int r = size / 2;
        Gray rows = new Gray(g.w, g.h);
        for (int y = 0; y < g.h; y++) {
            for (int x = 0; x < g.w; x++) {
                int m = 0;
                for (int k = Math.max(0, x - r); k <= Math.min(g.w - 1, x + r); k++) m = Math.max(m, g.v[y * g.w + k]);
                rows.v[y * g.w + x] = m;
            }
        }
        Gray out = new Gray(g.w, g.h);
        for (int y = 0; y < g.h; y++) {
            for (int x = 0; x < g.w; x++) {
                int m = 0;
                for (int k = Math.max(0, y - r); k <= Math.min(g.h - 1, y + r); k++) m = Math.max(m, rows.v[k * g.w + x]);
                out.v[y * g.w + x] = m;
            }
        }
        return out;
    }

    /** An image of one colour (0xRRGGBB) with `alpha` as its alpha channel. */
    static int[] solid(int rgb, Gray alpha) {
        int[] out = new int[alpha.v.length];
        for (int i = 0; i < out.length; i++) out[i] = (alpha.v[i] << 24) | rgb;
        return out;
    }

    /** Image.alpha_composite in place: `src` over `dst` at (dx, dy), clipped to `dst`. */
    static void alphaComposite(int[] dst, int dw, int dh, int[] src, int sw, int sh, int dx, int dy) {
        for (int y = 0; y < sh; y++) {
            int ty = dy + y;
            if (ty < 0 || ty >= dh) continue;
            for (int x = 0; x < sw; x++) {
                int tx = dx + x;
                if (tx < 0 || tx >= dw) continue;
                int s = src[y * sw + x];
                long sa = s >>> 24;
                if (sa == 0) continue;
                int d = dst[ty * dw + tx];
                long da = d >>> 24;
                long blend = da * (255 - sa);
                long outa255 = sa * 255 + blend;
                long coef1 = sa * 255 * 255 * 128 / outa255;
                long coef2 = 255 * 128 - coef1;
                int r = channel(((s >> 16) & 255) * coef1 + ((d >> 16) & 255) * coef2);
                int gr = channel(((s >> 8) & 255) * coef1 + ((d >> 8) & 255) * coef2);
                int b = channel((s & 255) * coef1 + (d & 255) * coef2);
                int a = (int) shiftForDiv255(outa255 + 0x80);
                dst[ty * dw + tx] = (a << 24) | (r << 16) | (gr << 8) | b;
            }
        }
    }

    private static int channel(long tmp) {
        return (int) (shiftForDiv255(tmp + (0x80 << 7)) >> 7);
    }

    private static long shiftForDiv255(long a) {
        return ((a >> 8) + a) >> 8;
    }

    // ---------------------------------------------------------------- resampling (Pillow's Resample.c, 8 bits)

    interface Filter {
        double support();

        double weight(double x);
    }

    static final Filter LANCZOS = new Filter() {
        public double support() {
            return 3.0;
        }

        public double weight(double x) {
            return -3.0 <= x && x < 3.0 ? sinc(x) * sinc(x / 3) : 0.0;
        }
    };

    static final Filter BICUBIC = new Filter() {
        public double support() {
            return 2.0;
        }

        public double weight(double x) {
            double a = -0.5;
            if (x < 0.0) x = -x;
            if (x < 1.0) return ((a + 2.0) * x - (a + 3.0)) * x * x + 1;
            if (x < 2.0) return (((x - 5) * x + 8) * x - 4) * a;
            return 0.0;
        }
    };

    private static double sinc(double x) {
        if (x == 0.0) return 1.0;
        x = x * Math.PI;
        return Math.sin(x) / x;
    }

    private static final int PRECISION_BITS = 32 - 8 - 2;

    /**
     * Image.resize for one 8-bit channel: two passes, each only if that size changes; like Pillow, the vertical one
     * first when the height shrinks by more than twice as many pixels as the width (the order changes the rounding).
     */
    static Gray resize(Gray g, int w, int h, Filter filter) {
        if (w < 1 || h < 1) throw new IllegalArgumentException("empty resize");
        boolean horizontalFirst = !(g.h - h > 0 && g.h - h > (g.w - w) * 2);
        Gray out = g;
        if (horizontalFirst && w != g.w) out = pass(out, w, filter, true);
        if (h != g.h) out = pass(out, h, filter, false);
        if (!horizontalFirst && w != g.w) out = pass(out, w, filter, true);
        return out == g ? crop(g, 0, 0, g.w, g.h) : out;
    }

    private static Gray pass(Gray in, int outSize, Filter filter, boolean horizontal) {
        int inSize = horizontal ? in.w : in.h;
        double scale = (double) inSize / outSize;
        double filterscale = Math.max(scale, 1.0);
        double support = filter.support() * filterscale;
        int ksize = (int) Math.ceil(support) * 2 + 1;
        int[] bounds = new int[outSize * 2];
        int[] kk = new int[outSize * ksize];
        double[] k = new double[ksize];
        for (int xx = 0; xx < outSize; xx++) {
            double center = (xx + 0.5) * scale;
            double ww = 0.0, ss = 1.0 / filterscale;
            int xmin = (int) (center - support + 0.5);
            if (xmin < 0) xmin = 0;
            int xmax = (int) (center + support + 0.5);
            if (xmax > inSize) xmax = inSize;
            xmax -= xmin;
            for (int x = 0; x < xmax; x++) {
                double w = filter.weight((x + xmin - center + 0.5) * ss);
                k[x] = w;
                ww += w;
            }
            for (int x = 0; x < xmax; x++) {
                double v = ww != 0.0 ? k[x] / ww : k[x];
                kk[xx * ksize + x] = v < 0 ? (int) (-0.5 + v * (1 << PRECISION_BITS))
                        : (int) (0.5 + v * (1 << PRECISION_BITS));
            }
            bounds[xx * 2] = xmin;
            bounds[xx * 2 + 1] = xmax;
        }
        Gray out = horizontal ? new Gray(outSize, in.h) : new Gray(in.w, outSize);
        int lines = horizontal ? in.h : in.w;
        for (int line = 0; line < lines; line++) {
            for (int xx = 0; xx < outSize; xx++) {
                int xmin = bounds[xx * 2], xmax = bounds[xx * 2 + 1];
                int sum = 1 << (PRECISION_BITS - 1);
                for (int x = 0; x < xmax; x++) {
                    int v = horizontal ? in.v[line * in.w + xmin + x] : in.v[(xmin + x) * in.w + line];
                    sum += v * kk[xx * ksize + x];
                }
                int value = sum >= (1 << PRECISION_BITS << 8) ? 255 : sum <= 0 ? 0 : sum >> PRECISION_BITS;
                if (horizontal) out.v[line * outSize + xx] = value;
                else out.v[xx * in.w + line] = value;
            }
        }
        return out;
    }
}
