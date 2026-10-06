package net.swvader.gibson;

// Focus score for label reading: variance of the 4-neighbour Laplacian on a grayscale image (higher = sharper).
// Pure Java (no Android types) so it can be unit-tested anywhere.
public final class Sharp {
  private Sharp() {}
  /** argb: packed pixels (w*h). Returns Laplacian variance of luma (0..255 scale). */
  public static double laplacianVariance(int[] argb, int w, int h) {
    if (w < 3 || h < 3) return 0;
    float[] g = new float[w * h];
    for (int i = 0; i < g.length; i++) { int p = argb[i]; g[i] = 0.299f * ((p >> 16) & 255) + 0.587f * ((p >> 8) & 255) + 0.114f * (p & 255); }
    double sum = 0, sum2 = 0; int n = 0;
    for (int y = 1; y < h - 1; y++) for (int x = 1; x < w - 1; x++) {
      int i = y * w + x;
      double l = g[i - 1] + g[i + 1] + g[i - w] + g[i + w] - 4 * g[i];
      sum += l; sum2 += l * l; n++;
    }
    double m = sum / n; return sum2 / n - m * m;
  }
}
