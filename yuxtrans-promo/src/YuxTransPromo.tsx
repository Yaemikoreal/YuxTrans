/**
 * YuxTrans 宣传片主合成（基于 Remotion fundamentals）
 * @see https://www.remotion.dev/docs/the-fundamentals
 */
import React from 'react';
import {
  AbsoluteFill,
  Easing,
  Img,
  interpolate,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';

/** 书房衬纸色（与 design-tokens 一致） */
const paper = '#F5F1EA';
const paperWarm = '#EDE8DF';
const ink = '#2C2825';
const annotation = '#9E968A';
const dusk = '#B8A5C4';

/**
 * 单段文字入场：透明度 + 轻微上移
 */
const FadeUp: React.FC<{
  children: React.ReactNode;
  delay?: number;
  style?: React.CSSProperties;
}> = ({ children, delay = 0, style }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const progress = spring({
    frame: frame - delay,
    fps,
    config: { damping: 200 },
  });
  const opacity = interpolate(progress, [0, 1], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const translateY = interpolate(progress, [0, 1], [24, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  return (
    <div
      style={{
        opacity,
        transform: `translateY(${translateY}px)`,
        ...style,
      }}
    >
      {children}
    </div>
  );
};

/**
 * 场景 A：Logo + 品牌句（约 0–2.5s）
 */
const SceneIntro: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const logoScale = spring({
    frame,
    fps,
    config: { damping: 18, stiffness: 80 },
  });

  return (
    <AbsoluteFill
      style={{
        backgroundColor: paperWarm,
        justifyContent: 'center',
        alignItems: 'center',
        fontFamily:
          'Inter, "PingFang SC", "Microsoft YaHei", system-ui, sans-serif',
      }}
    >
      {/* 极淡暮瞳光晕 */}
      <div
        style={{
          position: 'absolute',
          width: 720,
          height: 720,
          borderRadius: '50%',
          background: `radial-gradient(circle, ${dusk}33 0%, transparent 70%)`,
          opacity: interpolate(frame, [0, 30], [0, 1], {
            extrapolateRight: 'clamp',
          }),
        }}
      />
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 28,
          transform: `scale(${0.85 + logoScale * 0.15})`,
        }}
      >
        <Img
          src={staticFile('logo.png')}
          style={{ width: 160, height: 160, objectFit: 'contain' }}
        />
        <FadeUp delay={8}>
          <div
            style={{
              fontSize: 72,
              fontWeight: 600,
              color: ink,
              letterSpacing: '-0.02em',
            }}
          >
            YuxTrans
          </div>
        </FadeUp>
        <FadeUp delay={18}>
          <div
            style={{
              fontSize: 28,
              color: annotation,
              fontStyle: 'italic',
              maxWidth: 900,
              textAlign: 'center',
              lineHeight: 1.5,
            }}
          >
            翻译退至页边，阅读留在正中。
          </div>
        </FadeUp>
      </div>
    </AbsoluteFill>
  );
};

/**
 * 场景 B：产品主张（约 2.5–6s）
 */
const ScenePitch: React.FC = () => {
  const points = [
    { title: '本地优先', desc: 'Ollama 直连，敏感文本不出本机' },
    { title: '页边批注', desc: '译文跟在原文后，不抢阅读节奏' },
    { title: '整页可控', desc: '流式边译边显，取消即停' },
  ];

  return (
    <AbsoluteFill
      style={{
        backgroundColor: paper,
        padding: '80px 100px',
        fontFamily:
          'Inter, "PingFang SC", "Microsoft YaHei", system-ui, sans-serif',
        justifyContent: 'center',
      }}
    >
      <FadeUp>
        <div style={{ fontSize: 22, color: dusk, marginBottom: 16, letterSpacing: '0.08em' }}>
          深阅读 · 浏览器扩展
        </div>
      </FadeUp>
      <FadeUp delay={6}>
        <div
          style={{
            fontSize: 48,
            fontWeight: 600,
            color: ink,
            marginBottom: 48,
            lineHeight: 1.3,
            maxWidth: 1000,
          }}
        >
          给认真读长文的人的翻译
        </div>
      </FadeUp>
      <div style={{ display: 'flex', gap: 28 }}>
        {points.map((p, i) => (
          <FadeUp key={p.title} delay={16 + i * 10} style={{ flex: 1 }}>
            <div
              style={{
                backgroundColor: paperWarm,
                borderRadius: 8,
                padding: '28px 24px',
                borderLeft: `3px solid ${dusk}`,
                minHeight: 140,
              }}
            >
              <div style={{ fontSize: 26, fontWeight: 600, color: ink, marginBottom: 12 }}>
                {p.title}
              </div>
              <div style={{ fontSize: 20, color: annotation, lineHeight: 1.5 }}>
                {p.desc}
              </div>
            </div>
          </FadeUp>
        ))}
      </div>
    </AbsoluteFill>
  );
};

/**
 * 场景 C：产品截图（约 6–11s）
 */
const SceneProduct: React.FC = () => {
  const frame = useCurrentFrame();
  const shift = interpolate(frame, [0, 90], [0, -20], {
    extrapolateRight: 'clamp',
    easing: Easing.out(Easing.quad),
  });

  return (
    <AbsoluteFill
      style={{
        backgroundColor: paperWarm,
        fontFamily:
          'Inter, "PingFang SC", "Microsoft YaHei", system-ui, sans-serif',
      }}
    >
      <div
        style={{
          position: 'absolute',
          left: 80,
          top: 100,
          width: 620,
          transform: `translateY(${shift}px)`,
        }}
      >
        <FadeUp>
          <div style={{ fontSize: 20, color: annotation, marginBottom: 12 }}>
            划词翻译
          </div>
        </FadeUp>
        <FadeUp delay={6}>
          <Img
            src={staticFile('sample-selection.png')}
            style={{
              width: '100%',
              borderRadius: 8,
              boxShadow: '0 12px 40px rgba(44, 40, 37, 0.12)',
            }}
          />
        </FadeUp>
      </div>
      <div
        style={{
          position: 'absolute',
          right: 80,
          bottom: 80,
          width: 360,
          transform: `translateY(${-shift}px)`,
        }}
      >
        <FadeUp delay={12}>
          <div style={{ fontSize: 20, color: annotation, marginBottom: 12 }}>
            控制面板
          </div>
        </FadeUp>
        <FadeUp delay={18}>
          <Img
            src={staticFile('sample-popup.png')}
            style={{
              width: '100%',
              borderRadius: 8,
              boxShadow: '0 12px 40px rgba(44, 40, 37, 0.12)',
            }}
          />
        </FadeUp>
      </div>
    </AbsoluteFill>
  );
};

/**
 * 场景 D：收尾 CTA（约 11–15s）
 */
const SceneOutro: React.FC = () => {
  return (
    <AbsoluteFill
      style={{
        backgroundColor: ink,
        justifyContent: 'center',
        alignItems: 'center',
        fontFamily:
          'Inter, "PingFang SC", "Microsoft YaHei", system-ui, sans-serif',
      }}
    >
      <FadeUp>
        <Img
          src={staticFile('logo.png')}
          style={{
            width: 96,
            height: 96,
            objectFit: 'contain',
            marginBottom: 28,
            filter: 'brightness(1.15)',
          }}
        />
      </FadeUp>
      <FadeUp delay={8}>
        <div style={{ fontSize: 52, fontWeight: 600, color: paper, marginBottom: 16 }}>
          YuxTrans v0.5.0
        </div>
      </FadeUp>
      <FadeUp delay={16}>
        <div style={{ fontSize: 24, color: annotation, marginBottom: 36 }}>
          稳定版 · 开源浏览器扩展
        </div>
      </FadeUp>
      <FadeUp delay={24}>
        <div
          style={{
            fontSize: 22,
            color: dusk,
            letterSpacing: '0.02em',
          }}
        >
          github.com/Yaemikoreal/YuxTrans
        </div>
      </FadeUp>
    </AbsoluteFill>
  );
};

/**
 * 时间轴：15s @ 30fps = 450 frames
 * 0–75 intro | 75–180 pitch | 180–330 product | 330–450 outro
 */
export const YuxTransPromo: React.FC = () => {
  const frame = useCurrentFrame();

  const scenes: { from: number; to: number; node: React.ReactNode }[] = [
    { from: 0, to: 75, node: <SceneIntro /> },
    { from: 75, to: 180, node: <ScenePitch /> },
    { from: 180, to: 330, node: <SceneProduct /> },
    { from: 330, to: 450, node: <SceneOutro /> },
  ];

  return (
    <AbsoluteFill style={{ backgroundColor: paper }}>
      {scenes.map((s) => {
        if (frame < s.from || frame >= s.to) return null;
        // 场景交叉淡入淡出（末 8 帧 / 首 8 帧）
        const fadeIn = interpolate(frame, [s.from, s.from + 8], [0, 1], {
          extrapolateLeft: 'clamp',
          extrapolateRight: 'clamp',
        });
        const fadeOut = interpolate(frame, [s.to - 8, s.to], [1, 0], {
          extrapolateLeft: 'clamp',
          extrapolateRight: 'clamp',
        });
        const opacity = Math.min(fadeIn, fadeOut);
        return (
          <AbsoluteFill key={s.from} style={{ opacity }}>
            {s.node}
          </AbsoluteFill>
        );
      })}
    </AbsoluteFill>
  );
};
