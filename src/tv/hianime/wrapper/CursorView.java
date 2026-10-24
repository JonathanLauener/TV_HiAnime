package tv.hianime.wrapper;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.Path;
import android.view.View;

/** The remote-controlled mouse pointer. Purely visual: it never takes focus or touches. */
final class CursorView extends View {
    private final Paint fill = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint outline = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint ring = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Path arrow = new Path();
    private final float scale;
    private float x = -1, y = -1;
    private boolean pressed;

    CursorView(Context context) {
        super(context);
        // 1.4x the usual phone pointer so it reads from the sofa.
        scale = context.getResources().getDisplayMetrics().density * 1.4f;
        setFocusable(false);
        setClickable(false);
        setWillNotDraw(false);

        fill.setColor(Color.WHITE);
        fill.setStyle(Paint.Style.FILL);
        outline.setColor(0xFF111111);
        outline.setStyle(Paint.Style.STROKE);
        outline.setStrokeWidth(1.4f);
        outline.setStrokeJoin(Paint.Join.ROUND);
        ring.setColor(0xCCFF5E9C);
        ring.setStyle(Paint.Style.STROKE);
        ring.setStrokeWidth(2.5f);

        // Classic arrow pointer, tip at (0,0), in dp.
        arrow.moveTo(0, 0);
        arrow.lineTo(0, 21);
        arrow.lineTo(5.5f, 16);
        arrow.lineTo(9.5f, 24.5f);
        arrow.lineTo(13, 23);
        arrow.lineTo(9, 14.5f);
        arrow.lineTo(16, 14.5f);
        arrow.close();
    }

    float cursorX() {
        return x;
    }

    float cursorY() {
        return y;
    }

    void moveTo(float nx, float ny) {
        int w = getWidth(), h = getHeight();
        if (w > 0) nx = Math.max(0, Math.min(w - 1, nx));
        if (h > 0) ny = Math.max(0, Math.min(h - 1, ny));
        x = nx;
        y = ny;
        invalidate();
    }

    void setPressedLook(boolean p) {
        if (pressed != p) {
            pressed = p;
            invalidate();
        }
    }

    @Override
    protected void onSizeChanged(int w, int h, int oldw, int oldh) {
        super.onSizeChanged(w, h, oldw, oldh);
        if (x < 0 || y < 0) moveTo(w / 2f, h / 2f);
        else moveTo(x, y);
    }

    @Override
    protected void onDraw(Canvas canvas) {
        if (x < 0) return;
        canvas.save();
        canvas.translate(x, y);
        canvas.scale(scale, scale);
        if (pressed) canvas.drawCircle(0, 0, 9, ring);
        canvas.drawPath(arrow, fill);
        canvas.drawPath(arrow, outline);
        canvas.restore();
    }
}
