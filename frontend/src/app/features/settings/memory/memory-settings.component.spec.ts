import { ApplicationRef } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type { MemoryNoteDto } from '@app/shared-types';
import { MemorySettingsComponent } from './memory-settings.component';

function note(overrides: Partial<MemoryNoteDto> = {}): MemoryNoteDto {
  return {
    id: 'note-1',
    content: 'Lives in Bangkok',
    sourceSessionId: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('MemorySettingsComponent', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [MemorySettingsComponent],
      providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([])],
    });
  });

  afterEach(() => {
    TestBed.inject(HttpTestingController).verify();
  });

  it('loads memory notes on init', async () => {
    const fixture = TestBed.createComponent(MemorySettingsComponent);
    const http = TestBed.inject(HttpTestingController);

    const req = http.expectOne('/api/settings/memory');
    expect(req.request.method).toBe('GET');
    req.flush([note(), note({ id: 'note-2', content: 'Prefers dark mode' })]);
    await TestBed.inject(ApplicationRef).whenStable();

    expect(fixture.componentInstance.notes()).toHaveLength(2);
    expect(fixture.componentInstance.loading()).toBe(false);
  });

  it('surfaces a load error instead of throwing', async () => {
    const fixture = TestBed.createComponent(MemorySettingsComponent);
    const http = TestBed.inject(HttpTestingController);

    http.expectOne('/api/settings/memory').flush(null, { status: 500, statusText: 'Server Error' });
    await TestBed.inject(ApplicationRef).whenStable();

    expect(fixture.componentInstance.error()).toBe('Could not load memory notes.');
  });

  it('deletes a single note after confirmation and removes it from the list', async () => {
    const fixture = TestBed.createComponent(MemorySettingsComponent);
    const http = TestBed.inject(HttpTestingController);
    http.expectOne('/api/settings/memory').flush([note(), note({ id: 'note-2' })]);
    await TestBed.inject(ApplicationRef).whenStable();

    const component = fixture.componentInstance as unknown as {
      requestDelete: (n: MemoryNoteDto) => void;
      confirmDelete: () => Promise<void>;
      noteBeingDeleted: () => MemoryNoteDto | null;
    };
    component.requestDelete(note());
    expect(component.noteBeingDeleted()?.id).toBe('note-1');

    const deleting = component.confirmDelete();
    http.expectOne('/api/settings/memory/note-1').flush({ success: true });
    await deleting;

    expect(fixture.componentInstance.notes().map((n) => n.id)).toEqual(['note-2']);
    expect(component.noteBeingDeleted()).toBeNull();
  });

  it('deletes every note after confirming "delete all"', async () => {
    const fixture = TestBed.createComponent(MemorySettingsComponent);
    const http = TestBed.inject(HttpTestingController);
    http.expectOne('/api/settings/memory').flush([note(), note({ id: 'note-2' })]);
    await TestBed.inject(ApplicationRef).whenStable();

    const component = fixture.componentInstance as unknown as {
      requestDeleteAll: () => void;
      confirmDeleteAll: () => Promise<void>;
      confirmingDeleteAll: () => boolean;
    };
    component.requestDeleteAll();
    expect(component.confirmingDeleteAll()).toBe(true);

    const deleting = component.confirmDeleteAll();
    http.expectOne('/api/settings/memory').flush({ success: true });
    await deleting;

    expect(fixture.componentInstance.notes()).toEqual([]);
    expect(component.confirmingDeleteAll()).toBe(false);
  });
});
