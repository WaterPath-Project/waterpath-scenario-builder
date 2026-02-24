import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from './Dialog';
import { 
  FolderOpen, 
  FileText, 
  User, 
  Tag, 
  ExternalLink, 
  Save, 
  Edit3,
  X,
  Plus
} from 'lucide-react';

const MetadataDialog = ({ isOpen, onClose, datapackage, onSave, onReload }) => {
  const [originalData, setOriginalData] = useState({});
  const [tempEditData, setTempEditData] = useState({});
  const [isEditing, setIsEditing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    if (datapackage) {
      const clonedData = JSON.parse(JSON.stringify(datapackage)); // Deep clone
      setOriginalData(clonedData);
      setTempEditData(clonedData);
    }
  }, [datapackage]);

  // Helper function to get the current data to display
  const getCurrentData = useMemo(() => {
    return isEditing ? tempEditData : originalData;
  }, [isEditing, tempEditData, originalData]);

  // Stable data references to prevent re-renders
  const displayData = isEditing ? tempEditData : originalData;

  // Stable title for dialog header to prevent focus loss
  const dialogTitle = useMemo(() => {
    return originalData.title || 'Case Study Metadata';
  }, [originalData.title]);

  // All useCallback hooks must be at the top level
  const handleFieldChange = useCallback((path, value) => {
    setTempEditData(prevData => {
      const newData = { ...prevData };
      const keys = path.split('.');
      let current = newData;
      
      for (let i = 0; i < keys.length - 1; i++) {
        if (!current[keys[i]]) current[keys[i]] = {};
        current = current[keys[i]];
      }
      
      current[keys[keys.length - 1]] = value;
      return newData;
    });
  }, []);

  const handleArrayChange = useCallback((path, index, value) => {
    setTempEditData(prevData => {
      const newData = { ...prevData };
      const keys = path.split('.');
      let current = newData;
      
      for (let i = 0; i < keys.length - 1; i++) {
        current = current[keys[i]];
      }
      
      if (!current[keys[keys.length - 1]]) {
        current[keys[keys.length - 1]] = [];
      }
      
      current[keys[keys.length - 1]][index] = value;
      return newData;
    });
  }, []);

  const addArrayItem = useCallback((path, defaultValue = '') => {
    setTempEditData(prevData => {
      const newData = { ...prevData };
      const keys = path.split('.');
      let current = newData;
      
      for (let i = 0; i < keys.length - 1; i++) {
        if (!current[keys[i]]) current[keys[i]] = {};
        current = current[keys[i]];
      }
      
      if (!current[keys[keys.length - 1]]) {
        current[keys[keys.length - 1]] = [];
      }
      
      current[keys[keys.length - 1]].push(defaultValue);
      return newData;
    });
  }, []);

  const removeArrayItem = useCallback((path, index) => {
    setTempEditData(prevData => {
      const newData = { ...prevData };
      const keys = path.split('.');
      let current = newData;
      
      for (let i = 0; i < keys.length - 1; i++) {
        current = current[keys[i]];
      }
      
      current[keys[keys.length - 1]].splice(index, 1);
      return newData;
    });
  }, []);

  // Create memoized onChange handlers for main fields
  const handleNameChange = useCallback((value) => handleFieldChange('name', value), [handleFieldChange]);
  const handleTitleChange = useCallback((value) => handleFieldChange('title', value), [handleFieldChange]);
  const handleCreatedChange = useCallback((value) => handleFieldChange('created', value), [handleFieldChange]);
  const handleUpdatedChange = useCallback((value) => handleFieldChange('updated', value), [handleFieldChange]);
  const handleDescriptionChange = useCallback((value) => handleFieldChange('description', value), [handleFieldChange]);

  if (!datapackage) return null;

  const handleSave = async () => {
    if (onSave) {
      setIsSaving(true);
      try {
        await onSave(tempEditData);
        // Update original data to match what was saved
        setOriginalData(JSON.parse(JSON.stringify(tempEditData)));
        setIsEditing(false);
        
        // Reload case studies after successful save
        if (onReload) {
          await onReload();
        }
        
        onClose();
      } catch (error) {
        console.error('Error saving datapackage:', error);
        alert('Failed to save changes');
      } finally {
        setIsSaving(false);
      }
    }
  };

  const handleCancel = () => {
    // Revert to original data, discarding all temporary changes
    setTempEditData(JSON.parse(JSON.stringify(originalData)));
    setIsEditing(false);
  };

  const EditableField = ({ label, value, onChange, multiline = false, type = "text" }) => {
    if (!isEditing) {
      return <p className="text-gray-600">{value || 'N/A'}</p>;
    }

    if (multiline) {
      return (
        <textarea
          key={`${label}-${isEditing}`}
          defaultValue={value || ''}
          onBlur={(e) => onChange(e.target.value)}
          className="w-full p-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          rows={3}
        />
      );
    }

    if (type === "date") {
      const dateValue = value ? new Date(value).toISOString().split('T')[0] : '';
      return (
        <input
          key={`${label}-${isEditing}`}
          type="date"
          defaultValue={dateValue}
          onBlur={(e) => onChange(e.target.value ? new Date(e.target.value).toISOString() : '')}
          className="w-full p-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-transparent"
        />
      );
    }

    return (
      <input
        key={`${label}-${isEditing}`}
        type={type}
        defaultValue={value || ''}
        onBlur={(e) => onChange(e.target.value)}
        className="w-full p-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-transparent"
      />
    );
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <FolderOpen className="h-6 w-6 text-wpBlue-600" />
              <DialogTitle className="text-xl font-bold text-wpBlue-800">
                {dialogTitle}
              </DialogTitle>
            </div>
            <div className="flex gap-2">
              {!isEditing ? (
                <button
                  onClick={() => setIsEditing(true)}
                  className="flex items-center mr-4 mt-4 gap-1 px-3 py-1 bg-blue-500 text-white rounded-md hover:bg-blue-600 transition-colors"
                >
                  <Edit3 size={16} />
                  Edit
                </button>
              ) : (
                <div className="flex gap-2 mr-4 mt-4">
                  <button
                    onClick={handleSave}
                    disabled={isSaving}
                    className="flex items-center gap-1 px-3 py-1 bg-green-500 text-white rounded-md hover:bg-green-600 transition-colors disabled:opacity-50"
                  >
                    <Save size={16} />
                    {isSaving ? 'Saving...' : 'Save'}
                  </button>
                  <button
                    onClick={handleCancel}
                    className="flex items-center gap-1 px-3 py-1 bg-gray-500 text-white rounded-md hover:bg-gray-600 transition-colors"
                  >
                    <X size={16} />
                    Cancel
                  </button>
                </div>
              )}
            </div>
          </div>
          <DialogDescription>
            Complete metadata and resource information for this case study
          </DialogDescription>
        </DialogHeader>
        
        <div className="space-y-6">
          {/* Case Study Metadata */}
          <div className="bg-blue-50 p-4 rounded-lg">
            <div className="flex items-center gap-2 mb-3">
              <FileText className="h-5 w-5 text-wpBlue-600" />
              <h3 className="text-lg font-semibold text-wpBlue-800">Metadata</h3>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
              <div>
                <span className="font-medium text-gray-700">Name:</span>
                <EditableField
                  value={displayData.name}
                  onChange={handleNameChange}
                />
              </div>
              <div>
                <span className="font-medium text-gray-700">Title:</span>
                <EditableField
                  value={displayData.title}
                  onChange={handleTitleChange}
                />
              </div>
              <div>
                <span className="font-medium text-gray-700">Created:</span>
                <EditableField
                  value={displayData.created}
                  onChange={handleCreatedChange}
                  type="date"
                />
              </div>
              {(displayData.updated || isEditing) && (
                <div>
                  <span className="font-medium text-gray-700">Updated:</span>
                  <EditableField
                    value={displayData.updated}
                    onChange={handleUpdatedChange}
                    type="date"
                  />
                </div>
              )}
            </div>
            <div className="mt-4">
              <span className="font-medium text-gray-700">Description:</span>
              <EditableField
                value={displayData.description}
                onChange={handleDescriptionChange}
                multiline
              />
            </div>
            
            {/* Contributors */}
            <div className="mt-4">
              <div className="flex items-center gap-2 mb-2">
                <User className="h-4 w-4 text-gray-600" />
                <span className="font-medium text-gray-700">Contributors:</span>
                {isEditing && (
                  <button
                    onClick={() => addArrayItem('contributors', { title: '', role: 'author' })}
                    className="p-1 text-blue-600 hover:bg-blue-100 rounded"
                  >
                    <Plus size={16} />
                  </button>
                )}
              </div>
              {getCurrentData.contributors && getCurrentData.contributors.length > 0 ? (
                <div className="space-y-2">
                  {getCurrentData.contributors.map((contributor, index) => (
                    <div key={`contributor-${index}-${isEditing}`} className="flex gap-2 items-center">
                      {isEditing ? (
                        <>
                          <input
                            type="text"
                            placeholder="Name"
                            defaultValue={contributor.title || ''}
                            onBlur={(e) => handleArrayChange('contributors', index, { ...contributor, title: e.target.value })}
                            className="flex-1 p-1 border border-gray-300 rounded text-sm"
                          />
                          <input
                            type="text"
                            placeholder="Role"
                            defaultValue={contributor.role || ''}
                            onBlur={(e) => handleArrayChange('contributors', index, { ...contributor, role: e.target.value })}
                            className="w-24 p-1 border border-gray-300 rounded text-sm"
                          />
                          <button
                            onClick={() => removeArrayItem('contributors', index)}
                            className="p-1 text-red-600 hover:bg-red-100 rounded"
                          >
                            <X size={14} />
                          </button>
                        </>
                      ) : (
                        <p className="text-gray-600">{contributor.title} ({contributor.role})</p>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-gray-600">None listed</p>
              )}
            </div>
          </div>

          {/* Keywords */}
          <div className="bg-yellow-50 p-4 rounded-lg">
            <div className="flex items-center gap-2 mb-3">
              <Tag className="h-5 w-5 text-yellow-600" />
              <h3 className="text-lg font-semibold text-yellow-800">Keywords</h3>
              {isEditing && (
                <button
                  onClick={() => addArrayItem('keywords', '')}
                  className="p-1 text-yellow-600 hover:bg-yellow-100 rounded"
                >
                  <Plus size={16} />
                </button>
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              {getCurrentData.keywords && getCurrentData.keywords.length > 0 ? (
                getCurrentData.keywords.map((keyword, index) => (
                  <div key={index} className="flex items-center gap-1">
                    {isEditing ? (
                      <>
                        <input
                          type="text"
                          value={keyword}
                          onChange={(e) => handleArrayChange('keywords', index, e.target.value)}
                          className="px-2 py-1 bg-yellow-200 text-yellow-800 rounded-full text-sm border border-yellow-300"
                        />
                        <button
                          onClick={() => removeArrayItem('keywords', index)}
                          className="p-1 text-red-600 hover:bg-red-100 rounded-full"
                        >
                          <X size={12} />
                        </button>
                      </>
                    ) : (
                      <span className="px-2 py-1 bg-yellow-200 text-yellow-800 rounded-full text-sm">
                        {keyword}
                      </span>
                    )}
                  </div>
                ))
              ) : (
                <p className="text-gray-600">No keywords</p>
              )}
            </div>
          </div>

          {/* Sources and Licenses */}
          <div className="bg-purple-50 p-4 rounded-lg">
            <div className="flex items-center gap-2 mb-3">
              <ExternalLink className="h-5 w-5 text-purple-600" />
              <h3 className="text-lg font-semibold text-purple-800">Sources & Licenses</h3>
            </div>
            
            {/* Sources */}
            <div className="mb-4">
              <div className="flex items-center gap-2 mb-2">
                <span className="font-medium text-gray-700">Sources:</span>
                {isEditing && (
                  <button
                    onClick={() => addArrayItem('sources', { title: '', path: '' })}
                    className="p-1 text-purple-600 hover:bg-purple-100 rounded"
                  >
                    <Plus size={16} />
                  </button>
                )}
              </div>
              {getCurrentData.sources && getCurrentData.sources.length > 0 ? (
                <div className="space-y-2">
                  {getCurrentData.sources.map((source, index) => (
                    <div key={`source-${index}-${isEditing}`} className="flex gap-2 items-center">
                      {isEditing ? (
                        <>
                          <input
                            type="text"
                            placeholder="Title"
                            defaultValue={source.title || ''}
                            onBlur={(e) => handleArrayChange('sources', index, { ...source, title: e.target.value })}
                            className="flex-1 p-1 border border-gray-300 rounded text-sm"
                          />
                          <input
                            type="url"
                            placeholder="URL"
                            defaultValue={source.path || ''}
                            onBlur={(e) => handleArrayChange('sources', index, { ...source, path: e.target.value })}
                            className="flex-1 p-1 border border-gray-300 rounded text-sm"
                          />
                          <button
                            onClick={() => removeArrayItem('sources', index)}
                            className="p-1 text-red-600 hover:bg-red-100 rounded"
                          >
                            <X size={14} />
                          </button>
                        </>
                      ) : (
                        <a href={source.path} target="_blank" rel="noopener noreferrer" 
                           className="text-blue-600 hover:underline text-sm">
                          {source.title} ↗
                        </a>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-gray-600 text-sm">No sources</p>
              )}
            </div>
            
            {/* Licenses */}
            <div>
              <div className="flex items-center gap-2 mb-2">
                <span className="font-medium text-gray-700">Licenses:</span>
                {isEditing && (
                  <button
                    onClick={() => addArrayItem('licenses', { name: '', title: '', path: '' })}
                    className="p-1 text-purple-600 hover:bg-purple-100 rounded"
                  >
                    <Plus size={16} />
                  </button>
                )}
              </div>
              {getCurrentData.licenses && getCurrentData.licenses.length > 0 ? (
                <div className="space-y-2">
                  {getCurrentData.licenses.map((license, index) => (
                    <div key={index} className="flex gap-2 items-center">
                      {isEditing ? (
                        <>
                          <input
                            type="text"
                            placeholder="Name"
                            value={license.name || ''}
                            onChange={(e) => handleArrayChange('licenses', index, { ...license, name: e.target.value })}
                            className="flex-1 p-1 border border-gray-300 rounded text-sm"
                          />
                          <input
                            type="text"
                            placeholder="Title"
                            value={license.title || ''}
                            onChange={(e) => handleArrayChange('licenses', index, { ...license, title: e.target.value })}
                            className="flex-1 p-1 border border-gray-300 rounded text-sm"
                          />
                          <input
                            type="url"
                            placeholder="URL"
                            value={license.path || ''}
                            onChange={(e) => handleArrayChange('licenses', index, { ...license, path: e.target.value })}
                            className="flex-1 p-1 border border-gray-300 rounded text-sm"
                          />
                          <button
                            onClick={() => removeArrayItem('licenses', index)}
                            className="p-1 text-red-600 hover:bg-red-100 rounded"
                          >
                            <X size={14} />
                          </button>
                        </>
                      ) : (
                        <a href={license.path} target="_blank" rel="noopener noreferrer"
                           className="text-blue-600 hover:underline text-sm">
                          {license.title || license.name} ↗
                        </a>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-gray-600 text-sm">No licenses</p>
              )}
            </div>
          </div>

        </div>
      </DialogContent>
    </Dialog>
  );
};

export default MetadataDialog;
