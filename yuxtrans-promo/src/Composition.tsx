import React from 'react';
import { Composition } from 'remotion';
import { YuxTransPromo } from './YuxTransPromo';

/**
 * 注册可渲染合成（见官方 Composition 文档）
 * @see https://www.remotion.dev/docs/composition
 */
export const MyComposition: React.FC = () => {
  return (
    <>
      <Composition
        id="YuxTransPromo"
        component={YuxTransPromo}
        durationInFrames={450}
        fps={30}
        width={1920}
        height={1080}
      />
      {/* 短版 9:16 竖屏裁切可用第二合成，先提供横屏主片 */}
      <Composition
        id="YuxTransPromoSquare"
        component={YuxTransPromo}
        durationInFrames={450}
        fps={30}
        width={1080}
        height={1080}
      />
    </>
  );
};
