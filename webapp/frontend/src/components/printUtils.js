export function printMapContainer(map, title = 'Map') {
  const container = map?.getContainer?.();
  if (!container) return;
  const target = container.closest('[data-map-export-column]') || container;

  const previousTitle = document.title;
  document.title = title;
  document.body.classList.add('print-map-only');
  target.classList.add('print-map-target');

  try {
    window.print();
  } finally {
    target.classList.remove('print-map-target');
    document.body.classList.remove('print-map-only');
    document.title = previousTitle;
  }
}

export function printAnalyticsPage() {
  const previousTitle = document.title;
  document.title = 'WaterPath Scenario Builder - Analytics';
  document.body.classList.add('print-analytics');

  try {
    window.print();
  } finally {
    document.body.classList.remove('print-analytics');
    document.title = previousTitle;
  }
}