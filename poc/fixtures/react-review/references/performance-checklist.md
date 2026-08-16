# React 性能检查清单

- 是否有不必要的重渲染（memo / useMemo / useCallback）。
- 副作用依赖数组是否正确。
- 大列表是否虚拟化。
- 是否在渲染期做了重计算。
