import './index.css';
import { MyComposition } from './Composition';

/**
 * Remotion 入口根组件：注册全部 Composition
 * @see https://www.remotion.dev/docs/the-fundamentals#compositions
 */
export const RemotionRoot: React.FC = () => {
  return (
    <>
      <MyComposition />
    </>
  );
};
