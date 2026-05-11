"use server";
import { revalidatePath } from "next/cache";
import { requireAdminSessionFromCookies } from "@/lib/session";
import {
  createAlbum, updateAlbum, softDeleteAlbum,
  setCover, reorderPhotos, deletePhoto,
} from "@/lib/albums";
import type { AlbumStatus } from "@/lib/types";

async function gate(): Promise<void> {
  const auth = await requireAdminSessionFromCookies();
  if (!auth.ok) throw new Error("unauthorized");
}

export async function createAlbumAction(input: {
  title: string; subtitle: string | null; status: AlbumStatus;
}): Promise<string> {
  await gate();
  const a = await createAlbum(input);
  revalidatePath("/admin/albums");
  return a.slug;
}

export async function updateAlbumAction(id: string, patch: {
  title?: string; subtitle?: string | null; status?: AlbumStatus;
}): Promise<void> {
  await gate();
  await updateAlbum(id, patch);
  revalidatePath("/admin/albums");
}

export async function softDeleteAlbumAction(id: string): Promise<void> {
  await gate();
  await softDeleteAlbum(id);
  revalidatePath("/admin/albums");
}

export async function setCoverAction(albumId: string, photoId: string): Promise<void> {
  await gate();
  await setCover(albumId, photoId);
  revalidatePath("/admin/albums");
}

export async function reorderPhotosAction(albumId: string, orderedIds: string[]): Promise<void> {
  await gate();
  await reorderPhotos(albumId, orderedIds);
}

export async function deletePhotoAction(photoId: string): Promise<void> {
  await gate();
  await deletePhoto(photoId);
}
