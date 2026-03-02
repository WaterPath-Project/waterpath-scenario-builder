import React, { useState, useEffect } from 'react';
import { ReactGrid } from '@silevis/reactgrid';
import '@silevis/reactgrid/styles.css';

const DataGridView = ({ data, fieldnames, onDataChange, readOnly = false }) => {
  const [rows, setRows] = useState([]);
  const [columns, setColumns] = useState([]);

  useEffect(() => {
    if (!data || data.length === 0) {
      setRows([]);
      setColumns([]);
      return;
    }

    // Use fieldnames prop to preserve original CSV column order
    // Fallback to Object.keys only if fieldnames not provided
    const headers = (fieldnames && fieldnames.length > 0) ? fieldnames : Object.keys(data[0]);
    console.log('Column order (headers):', headers);

    // Create columns for ReactGrid
    const gridColumns = [
      { columnId: 'rowNumber' }, // Row number column
      ...headers.map(header => ({
        columnId: header,
        resizable: true
      }))
    ];

    // Create header row
    const headerRow = {
      rowId: 'header',
      cells: [
        { type: 'header', text: '#' },
        ...headers.map(header => ({ type: 'header', text: header }))
      ]
    };

    // Create data rows
    const dataRows = data.map((row, index) => ({
      rowId: index,
      cells: [
        { type: 'header', text: (index + 1).toString() },
        ...headers.map(header => ({
          type: 'text',
          text: String(row[header] || ''),
          nonEditable: readOnly,
        }))
      ]
    }));

    console.log('Grid columns order:', gridColumns.map(c => c.columnId));
    setColumns(gridColumns);
    setRows([headerRow, ...dataRows]);
  }, [data, fieldnames]);

  const handleChanges = (changes) => {
    if (!onDataChange || !changes.length) return;

    // Apply changes to the rows
    const updatedRows = [...rows];
    changes.forEach(change => {
      const rowIndex = updatedRows.findIndex(row => row.rowId === change.rowId);
      if (rowIndex > 0) { // Skip header row (index 0)
        const columnIndex = columns.findIndex(col => col.columnId === change.columnId);
        if (columnIndex > 0) { // Skip row number column (index 0)
          updatedRows[rowIndex].cells[columnIndex] = change.newCell;
        }
      }
    });

    setRows(updatedRows);

    // Convert back to original data format
    const headers = columns.slice(1).map(col => col.columnId);
    const newData = updatedRows.slice(1).map(row => {
      const dataRow = {};
      headers.forEach((header, index) => {
        dataRow[header] = row.cells[index + 1].text;
      });
      return dataRow;
    });

    onDataChange(newData);
  };

  if (!data || data.length === 0) {
    return (
      <div className="text-center py-8 text-gray-500">
        <p>No data available to display</p>
      </div>
    );
  }
  console.log(columns);

  return (
    <div className="w-screen">
      <div className="border border-gray-200 rounded-lg overflow-hidden">
        <div className="overflow-auto" style={{ height: '400px', width: '100%' }}>
          <ReactGrid 
            rows={rows} 
            columns={columns} 
            onCellsChanged={handleChanges}
            enableColumnSelection
            enableRowSelection
            enableRangeSelection
          />
        </div>
      </div>
      <div className="mt-2 text-sm text-gray-500">
        {rows.length - 1} rows × {columns.length - 1} columns
      </div>
    </div>
  );
};

export default DataGridView;
