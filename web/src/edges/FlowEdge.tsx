import { BaseEdge, getBezierPath, type EdgeProps } from '@xyflow/react';

const REDUCED =
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Animated, color-coded edge: a faint base line, a marching dashed overlay, and a
 * pulse token that rides the path (the "flow moving" from the landing diagram).
 * `data.color` tints the whole edge; `data.loading` speeds the pulse during a load run.
 */
export function FlowEdge({
  sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, markerEnd, data,
}: EdgeProps) {
  const [edgePath] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition });
  const color = (data?.color as string) ?? '#3a4862';
  const loading = Boolean(data?.loading);
  const dur = loading ? '0.9s' : '1.9s';

  return (
    <>
      <BaseEdge path={edgePath} markerEnd={markerEnd} style={{ stroke: color, strokeOpacity: 0.45, strokeWidth: 1.6 }} />
      {!REDUCED && (
        <path
          d={edgePath}
          fill="none"
          stroke={color}
          strokeWidth={1.6}
          strokeLinecap="round"
          strokeDasharray="4 7"
          className="sds-flow-dash"
          style={{ pointerEvents: 'none' }}
        />
      )}
      {!REDUCED && (
        <circle r={3.4} fill={color} style={{ filter: 'drop-shadow(0 0 3px ' + color + ')' }}>
          <animateMotion dur={dur} repeatCount="indefinite" path={edgePath} />
        </circle>
      )}
    </>
  );
}
