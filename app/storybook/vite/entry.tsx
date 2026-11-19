import '../../../react-spectrum/.storybook-s2/global.css';
import preview from '../../../react-spectrum/.storybook-s2/preview.tsx';

const docs = import.meta.glob('../../../react-spectrum/.storybook-s2/docs/*.mdx');
const s2Stories = import.meta.glob('../../../react-spectrum/packages/@react-spectrum/s2/stories/*.stories.{js,jsx,mjs,ts,tsx}');
const aiStories = import.meta.glob('../../../react-spectrum/packages/@react-spectrum/ai/stories/*.stories.{js,jsx,mjs,ts,tsx}');

export const stories = {
  ...docs,
  ...s2Stories,
  ...aiStories
};

export {preview};
console.log('Storybook entries loaded:', Object.keys(stories).length);
