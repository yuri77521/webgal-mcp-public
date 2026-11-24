// Build a changeFigure command from names verified against the saved model.
export function buildFigureCue({ figure, motion, expression }) {
  const literal = value => typeof value === 'string' && value.length > 0 && value.trim() === value
    && !/[;:\\{}|\r\n]/u.test(value) && !/\s-/u.test(value);
  if (!literal(figure?.modelPath) || !/\.json$/iu.test(figure.modelPath)
    || !figure.modelPath.split('/').every(part => part && part !== '.' && part !== '..')) {
    throw new Error('Use the inspected model entry relative to game/figure.');
  }
  if (!['left', 'center', 'right'].includes(figure.slot)) throw new Error('Supply the active figure slot.');
  if (figure.id !== undefined && !literal(figure.id)) throw new Error('Supply the active figure ID.');
  if ((motion === undefined && expression === undefined) || (motion !== undefined && !literal(motion))
    || (expression !== undefined && !literal(expression))) {
    throw new Error('Supply at least one verified literal motion or expression name.');
  }
  const args = [`changeFigure:${figure.modelPath}`];
  if (figure.id !== undefined) args.push(`-id=${figure.id}`);
  if (figure.slot !== 'center') args.push(`-${figure.slot}`);
  if (motion !== undefined) args.push(`-motion=${motion}`);
  if (expression !== undefined) args.push(`-expression=${expression}`);
  return args.join(' ') + ' -next;';
}
